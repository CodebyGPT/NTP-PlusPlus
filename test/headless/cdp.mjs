// Minimal Chrome DevTools Protocol client + Chromium launcher.
// No npm dependencies: Node's global WebSocket and a hand-rolled JSON-RPC.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;

    ws.addEventListener('message', (event) => this.handleMessage(event.data));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) {
        reject(new Error('CDP connection closed'));
      }
      this.pending.clear();
    });
  }

  static async connect(url, { timeoutMs = 15000 } = {}) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out connecting to ${url}`)),
        timeoutMs,
      );
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error(`WebSocket error connecting to ${url}`));
        },
        { once: true },
      );
    });
    return new CdpConnection(ws);
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(
          message.error.message ?? `CDP error ${message.error.code}`,
        );
        error.cdp = message.error;
        reject(error);
      } else {
        resolve(message.result);
      }
      return;
    }

    if (!message.method) {
      return;
    }

    for (const handler of this.handlers.get(message.method) ?? []) {
      try {
        handler(message.params, message);
      } catch {
        // A broken test listener must not take down the protocol pump.
      }
    }
  }

  send(method, params = {}, sessionId) {
    if (this.closed) {
      return Promise.reject(new Error(`CDP connection is closed (${method})`));
    }

    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  on(method, handler) {
    if (!this.handlers.has(method)) {
      this.handlers.set(method, []);
    }
    this.handlers.get(method).push(handler);
    return () => {
      const list = this.handlers.get(method) ?? [];
      const index = list.indexOf(handler);
      if (index >= 0) {
        list.splice(index, 1);
      }
    };
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // Already closed.
    }
  }
}

export async function launchChromium({
  chromePath,
  userDataDir,
  distPath,
  timeoutMs = 25000,
}) {
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    `--disable-extensions-except=${distPath}`,
    `--load-extension=${distPath}`,
    'about:blank',
  ];

  const child = spawn(chromePath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stderr = '';
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-8000);
  });
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8000);
  });

  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  let portContents;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(portFile, 'utf8');
      if (text.trim()) {
        portContents = text;
        break;
      }
    } catch {
      // Not written yet.
    }
    if (child.exitCode !== null) {
      throw new Error(
        `Chromium exited before DevTools started (code ${child.exitCode}).\n${stderr}`,
      );
    }
    await sleep(100);
  }

  if (!portContents) {
    try {
      child.kill();
    } catch {
      // Ignore.
    }
    throw new Error(
      `Chromium did not write DevToolsActivePort within ${timeoutMs}ms.\n${stderr}`,
    );
  }

  const [port, wsPath] = portContents.trim().split(/\r?\n/);
  const cdp = await CdpConnection.connect(
    `ws://127.0.0.1:${port}${wsPath}`,
  );

  return {
    child,
    cdp,
    diagnostics: () => ({ stdout, stderr }),
    async close() {
      try {
        await cdp.send('Browser.close');
      } catch {
        // Browser may already be gone.
      }

      const exited = new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('exit', resolve);
      });
      await Promise.race([exited, sleep(3000)]);

      if (child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore.
        }
      }
      cdp.close();
    },
  };
}
