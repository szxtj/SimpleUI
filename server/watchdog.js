// 受管服务的「父进程死亡」兜底看门狗（ttf / asr 共用）
//
// 背景：Node 代理被 SIGKILL、或整个 App 崩溃时，代理来不及执行自己的退出钩子，
// 受管服务（TurboFieldfareServer / audiocpp_server）就会变成孤儿进程继续跑。
// 看门狗是一个 detached 的 bash 循环，只监视代理进程；代理消失后由它接手终止服务。
// 正常退出（SIGTERM）走代理自己的 cleanupAndExit 钩子，不依赖这里。
//
// 设计约束 —— 每一条都是踩过的坑：
//
//  1. **绝不使用 `pkill -f <名字>`。** `pkill -f` 匹配的是**整条命令行**，任何 argv 里
//     含该字符串的进程都会被杀掉：终端里手动跑的实例、编辑器、脚本、乃至探针 shell。
//     实测中探针 shell 就是这样被误杀的（退出码 143）。这里只对「自己记下来的 PID」动手。
//
//  2. **PID 只在代理存活期间持续跟踪。** 每轮循环读 PID 文件，值变了就更新跟踪目标。
//     这样既跟得上服务的重启（重启后 PID 文件被重写），又不会在代理死后读到
//     **新实例**写进去的 PID 而误杀新服务 —— 旧实现（每轮 `pkill`）存在这个竞态：
//     退出后立刻重开 App，旧 watchdog 会把新拉起的服务硬杀掉。
//
//  3. **动手前做一次命令行校验。** 用 `ps -o args=` 确认该 PID 的命令行里确有二进制名，
//     避免 PID 复用（陈旧 PID 文件指向了无关进程）时误杀。校验是**失败放行**的：
//     `ps` 不可用/输出为空时不阻断清理 —— 否则校验本身就成了「服务残留」的原因。
//
//  4. 清理结束后**只在 PID 文件内容仍等于自己跟踪的值时**才删除它，
//     避免把新实例刚写进去的 PID 文件删掉。

import { spawn } from 'child_process';

/**
 * 拉起一个 detached 看门狗，监视 owner 进程；owner 消失后按 PID 精确终止受管服务。
 *
 * @param {object} opts
 * @param {string} opts.pidFile          受管服务的 PID 文件（代理存活期间被持续跟踪）
 * @param {string} opts.binaryBasename   受管服务二进制名（仅用于命令行校验，不做全局匹配）
 * @param {number} [opts.owner]          被监视的进程 PID，默认当前进程
 * @returns {import('child_process').ChildProcess} 看门狗句柄（已 unref，不阻止父进程退出）
 */
export function startWatchdog({ pidFile, binaryBasename, owner = process.pid }) {
  const script = [
    'set +e',
    `OWNER=${owner}`,
    `PIDFILE='${pidFile}'`,
    `NEEDLE='${binaryBasename}'`,
    `TRACK=''`,
    // 代理存活期间持续跟踪 PID 文件（代理死后立即退出循环，不再读取）
    'while kill -0 "$OWNER" 2>/dev/null; do',
    '  P=$(cat "$PIDFILE" 2>/dev/null)',
    '  [ -n "$P" ] && [ "$P" != "$TRACK" ] && TRACK="$P"',
    '  sleep 0.5',
    'done',
    // 只处理自己在代理存活期间亲眼见过的那个 PID
    'if [ -n "$TRACK" ] && kill -0 "$TRACK" 2>/dev/null; then',
    '  ARGS=$(/bin/ps -o args= -p "$TRACK" 2>/dev/null)',
    '  SKIP=0',
    '  if [ -n "$ARGS" ]; then case "$ARGS" in *"$NEEDLE"*) ;; *) SKIP=1 ;; esac; fi',
    '  if [ "$SKIP" = "0" ]; then',
    '    kill -TERM "$TRACK" 2>/dev/null',
    '    i=0',
    '    while [ $i -lt 20 ] && kill -0 "$TRACK" 2>/dev/null; do sleep 0.5; i=$((i+1)); done',
    '    kill -0 "$TRACK" 2>/dev/null && kill -9 "$TRACK" 2>/dev/null',
    '  fi',
    'fi',
    // 仅当 PID 文件仍是自己的目标时才清理，避免删掉新实例刚写入的内容
    '[ "$(cat "$PIDFILE" 2>/dev/null)" = "$TRACK" ] && rm -f "$PIDFILE"',
    'exit 0',
  ].join('\n');

  const child = spawn('/bin/bash', ['-c', script], { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}
