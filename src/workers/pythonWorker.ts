export interface WorkerMessageRequest {
  id: string;
  type: 'RUN' | 'PRELOAD' | 'CANCEL';
  code?: string;
}

export interface WorkerMessageResponse {
  id: string;
  type: 'STATUS' | 'STDOUT' | 'STDERR' | 'SUCCESS' | 'ERROR';
  status?: 'initializing' | 'loading_packages' | 'running';
  text?: string;
  result?: string | null;
  error?: string;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
}

let pyodideInstance: any = null;
let initPromise: Promise<any> | null = null;

let currentExecutionId: string | null = null;
let currentStdout = '';
let currentStderr = '';

// Runner script injected into Pyodide once at startup
const RUNNER_SCRIPT = `
import ast
import traceback
import json

def __simpleui_run__(code_str):
    try:
        tree = ast.parse(code_str)
        if not tree.body:
            return json.dumps({"ok": True, "result": None})
        last_node = tree.body[-1]
        g = globals()
        if isinstance(last_node, ast.Expr):
            mod = ast.Module(body=tree.body[:-1], type_ignores=[])
            expr = ast.Expression(body=last_node.value)
            exec(compile(mod, '<sandbox>', 'exec'), g)
            res = eval(compile(expr, '<sandbox>', 'eval'), g)
            return json.dumps({"ok": True, "result": repr(res) if res is not None else None})
        else:
            exec(compile(tree, '<sandbox>', 'exec'), g)
            return json.dumps({"ok": True, "result": None})
    except Exception:
        return json.dumps({"ok": False, "error": traceback.format_exc()})
`;

async function getPyodide(): Promise<any> {
  if (pyodideInstance) return pyodideInstance;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const pyodideModulePath = '/pyodide/pyodide.mjs';
    const { loadPyodide } = await import(/* @vite-ignore */ (pyodideModulePath as any));
    const py = await loadPyodide({
      indexURL: '/pyodide/',
      stdout: (text: string) => {
        currentStdout += text + '\n';
        if (currentExecutionId) {
          self.postMessage({
            id: currentExecutionId,
            type: 'STDOUT',
            text,
          } as WorkerMessageResponse);
        }
      },
      stderr: (text: string) => {
        currentStderr += text + '\n';
        if (currentExecutionId) {
          self.postMessage({
            id: currentExecutionId,
            type: 'STDERR',
            text,
          } as WorkerMessageResponse);
        }
      },
    });

    await py.runPythonAsync(RUNNER_SCRIPT);
    pyodideInstance = py;
    return py;
  })();

  return initPromise;
}

self.onmessage = async (e: MessageEvent<WorkerMessageRequest>) => {
  const { id, type, code } = e.data;

  if (type === 'PRELOAD') {
    try {
      await getPyodide();
      self.postMessage({
        id,
        type: 'STATUS',
        status: 'running',
      } as WorkerMessageResponse);
    } catch (err: any) {
      console.error('Failed to preload Pyodide:', err);
    }
    return;
  }

  if (type === 'RUN' && typeof code === 'string') {
    currentExecutionId = id;
    currentStdout = '';
    currentStderr = '';
    const startTime = performance.now();

    try {
      self.postMessage({
        id,
        type: 'STATUS',
        status: 'initializing',
      } as WorkerMessageResponse);

      const py = await getPyodide();

      self.postMessage({
        id,
        type: 'STATUS',
        status: 'loading_packages',
      } as WorkerMessageResponse);

      // Auto-detect and load required packages (e.g. numpy, sympy, scipy)
      await py.loadPackagesFromImports(code);

      self.postMessage({
        id,
        type: 'STATUS',
        status: 'running',
      } as WorkerMessageResponse);

      py.globals.set('__simpleui_code_input__', code);
      const rawJson = await py.runPythonAsync('__simpleui_run__(__simpleui_code_input__)');
      const durationMs = Math.round(performance.now() - startTime);

      let parsed: { ok: boolean; result?: string | null; error?: string };
      try {
        parsed = JSON.parse(rawJson);
      } catch {
        parsed = { ok: true, result: String(rawJson) };
      }

      if (parsed.ok) {
        self.postMessage({
          id,
          type: 'SUCCESS',
          result: parsed.result,
          stdout: currentStdout.trimEnd(),
          stderr: currentStderr.trimEnd(),
          durationMs,
        } as WorkerMessageResponse);
      } else {
        self.postMessage({
          id,
          type: 'ERROR',
          error: parsed.error || 'Execution failed',
          stdout: currentStdout.trimEnd(),
          stderr: currentStderr.trimEnd(),
          durationMs,
        } as WorkerMessageResponse);
      }
    } catch (err: any) {
      const durationMs = Math.round(performance.now() - startTime);
      self.postMessage({
        id,
        type: 'ERROR',
        error: err?.message || String(err),
        stdout: currentStdout.trimEnd(),
        stderr: currentStderr.trimEnd(),
        durationMs,
      } as WorkerMessageResponse);
    } finally {
      if (currentExecutionId === id) {
        currentExecutionId = null;
      }
    }
  }
};
