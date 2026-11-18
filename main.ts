// Entry point: one process, one in-memory forge.
//
// Lifecycle (the suite's side): bind a temporary port, register it with the
// environment at $MAKEFUN_ENV_URL, then poll GET /done until the suite says
// the trial is over and exit 0. With no $MAKEFUN_ENV_URL set (local runs),
// just serve until killed; $MAKEFUN_PORT pins the port for the local runner.

import { createApp } from './src/app.ts';
import { Store } from './src/store.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const store = new Store();
  const server = createApp(store);
  const fixedPort = process.env.MAKEFUN_PORT !== undefined ? parseInt(process.env.MAKEFUN_PORT, 10) : NaN;
  const listenPort = Number.isNaN(fixedPort) ? 0 : fixedPort;
  await new Promise<void>((resolve) => {
    server.listen(listenPort, '0.0.0.0', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : listenPort;
  console.log(`forge listening on ${port}`);

  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/$/, '');
  if (envUrl === '') return;

  // Register this port with the environment, retrying briefly while it starts.
  let registered = false;
  for (let attempt = 0; attempt < 40 && !registered; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 200 || res.status === 409) registered = true;
      else await sleep(500);
    } catch {
      await sleep(500);
    }
  }
  if (!registered) {
    console.error('forge: could not register with the environment');
    process.exit(1);
  }

  // Poll for completion: short intervals first, backing off to 2s.
  let delay = 250;
  for (;;) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(30000) });
      const data = (await res.json()) as { done?: unknown };
      if (data.done === true) process.exit(0);
    } catch {
      // The environment answers within a second; a failed poll just retries.
    }
    await sleep(delay);
    delay = Math.min(2000, Math.floor(delay * 1.5));
  }
}

process.on('SIGTERM', () => process.exit(0));

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
