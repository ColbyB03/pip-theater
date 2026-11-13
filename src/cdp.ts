import { callable } from "@decky/api";

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
}

const cdpTargets = callable<[], CdpTarget[]>("cdp_targets");

type EventHandler = (params: any) => void;

/** Minimal Chrome DevTools Protocol client over a WebSocket. */
export class CdpClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private handlers = new Map<string, Set<EventHandler>>();
  closed = false;
  onClose?: () => void;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (typeof msg.id === "number") {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method) {
        this.handlers.get(msg.method)?.forEach((h) => h(msg.params));
      }
    };
    ws.onclose = () => {
      this.closed = true;
      this.pending.forEach((p) => p.reject(new Error("CDP connection closed")));
      this.pending.clear();
      this.onClose?.();
    };
  }

  static connect(url: string, timeoutMs = 5000): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("CDP connect timeout"));
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(new CdpClient(ws));
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("CDP connect failed"));
      };
    });
  }

  send<T = any>(method: string, params: object = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error("CDP connection closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, handler: EventHandler): () => void {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method)!.add(handler);
    return () => {
      this.handlers.get(method)?.delete(handler);
    };
  }

  evaluate(expression: string) {
    return this.send("Runtime.evaluate", { expression, awaitPromise: false, userGesture: true });
  }

  close() {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/** Waits for the external browser's page target and opens a new connection to it. */
export async function connectToPage(timeoutMs = 30000): Promise<CdpClient> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = new Error("browser page not found");
  while (Date.now() < deadline) {
    try {
      const targets = await cdpTargets();
      const page = targets.find(
        (t) => t.type === "page" && t.webSocketDebuggerUrl && !t.url.startsWith("devtools://"),
      );
      if (page?.webSocketDebuggerUrl) {
        return await CdpClient.connect(page.webSocketDebuggerUrl.replace("localhost", "127.0.0.1"));
      }
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  throw lastError;
}
