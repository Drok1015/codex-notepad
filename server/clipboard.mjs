import { spawn } from 'node:child_process';

export function writeClipboard(text) {
  if (process.platform !== 'darwin') return Promise.reject(new Error('当前系统暂不支持本地剪贴板复制。'));
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/pbcopy', [], {
      stdio: ['pipe', 'ignore', 'ignore'],
      env: { ...process.env, LC_ALL: 'en_US.UTF-8' },
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error('复制超时，请重试。')); }, 5000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(); else reject(new Error('无法写入剪贴板，请重试。'));
    });
    child.stdin.end(text, 'utf8');
  });
}
