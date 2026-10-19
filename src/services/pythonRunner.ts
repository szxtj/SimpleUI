import type { WorkerMessageRequest, WorkerMessageResponse } from '../workers/pythonWorker';

export interface PythonExecutionResult {
  stdout: string;
  stderr: string;
  result?: string | null;
  error?: string;
  durationMs: number;
}

export type PythonStatusCallback = (status: 'initializing' | 'loading_packages' | 'running') => void;
export type PythonOutputCallback = (text: string) => void;

class PythonRunner {
  private worker: Worker | null = null;
  private currentExecutionId: string | null = null;
  private currentReject: ((reason?: any) => void) | null = null;
  private currentTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('../workers/pythonWorker.ts', import.meta.url), {
        type: 'module',
      });
    }
    return this.worker;
  }

  public terminateWorker() {
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch (e) {
        console.warn('Error terminating Python worker:', e);
      }
      this.worker = null;
    }
    if (this.currentTimeoutTimer) {
      clearTimeout(this.currentTimeoutTimer);
      this.currentTimeoutTimer = null;
    }
    if (this.currentReject) {
      this.currentReject(new Error('Execution cancelled'));
      this.currentReject = null;
    }
    this.currentExecutionId = null;
  }

  public preload() {
    try {
      const worker = this.getWorker();
      worker.postMessage({ id: 'preload', type: 'PRELOAD' } as WorkerMessageRequest);
    } catch (e) {
      console.warn('Preloading Pyodide failed:', e);
    }
  }

  public cancel(executionId?: string) {
    if (!this.currentExecutionId) return;
    if (executionId && this.currentExecutionId !== executionId) return;
    this.terminateWorker();
  }

  public run(
    code: string,
    options?: {
      onStatus?: PythonStatusCallback;
      onStdout?: PythonOutputCallback;
      onStderr?: PythonOutputCallback;
      timeoutMs?: number;
    }
  ): Promise<PythonExecutionResult> {
    // If a task is already running, cancel it first
    if (this.currentExecutionId) {
      this.terminateWorker();
    }

    return new Promise<PythonExecutionResult>((resolve, reject) => {
      const id = 'exec_' + Math.random().toString(36).slice(2, 9);
      this.currentExecutionId = id;
      this.currentReject = reject;

      let worker: Worker;
      try {
        worker = this.getWorker();
      } catch (err) {
        this.currentExecutionId = null;
        this.currentReject = null;
        return reject(err);
      }

      const timeoutMs = options?.timeoutMs || 45000;
      this.currentTimeoutTimer = setTimeout(() => {
        this.terminateWorker();
        resolve({
          stdout: '',
          stderr: '',
          error: `Execution timed out after ${Math.round(timeoutMs / 1000)}s`,
          durationMs: timeoutMs,
        });
      }, timeoutMs);

      const cleanupListener = () => {
        if (this.currentTimeoutTimer) {
          clearTimeout(this.currentTimeoutTimer);
          this.currentTimeoutTimer = null;
        }
        this.currentExecutionId = null;
        this.currentReject = null;
        worker.removeEventListener('message', handleMessage);
        worker.removeEventListener('error', handleError);
      };

      const handleMessage = (e: MessageEvent<WorkerMessageResponse>) => {
        const data = e.data;
        if (!data || data.id !== id) return;

        if (data.type === 'STATUS' && data.status) {
          options?.onStatus?.(data.status);
          return;
        }

        if (data.type === 'STDOUT' && data.text !== undefined) {
          options?.onStdout?.(data.text);
          return;
        }

        if (data.type === 'STDERR' && data.text !== undefined) {
          options?.onStderr?.(data.text);
          return;
        }

        if (data.type === 'SUCCESS') {
          cleanupListener();
          resolve({
            stdout: data.stdout || '',
            stderr: data.stderr || '',
            result: data.result,
            durationMs: data.durationMs || 0,
          });
          return;
        }

        if (data.type === 'ERROR') {
          cleanupListener();
          resolve({
            stdout: data.stdout || '',
            stderr: data.stderr || '',
            error: data.error || 'Execution failed',
            durationMs: data.durationMs || 0,
          });
          return;
        }
      };

      const handleError = (err: ErrorEvent) => {
        cleanupListener();
        this.terminateWorker();
        resolve({
          stdout: '',
          stderr: '',
          error: err.message || 'Python worker error occurred',
          durationMs: 0,
        });
      };

      worker.addEventListener('message', handleMessage);
      worker.addEventListener('error', handleError);

      worker.postMessage({ id, type: 'RUN', code } as WorkerMessageRequest);
    });
  }
}

export const pythonRunner = new PythonRunner();
