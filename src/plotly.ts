import * as http from 'http';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function openPlot(data: any[], layout: any, config: any = {}): Promise<void> {
  const html = generateHtml(data, layout, config);
  await serveAndOpen(html);
}

async function serveAndOpen(html: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      setTimeout(() => server.close(() => resolve()), 500);
    });

    server.on('error', reject);

    server.listen(0, '127.0.0.1', async () => {
      const addr = server.address() as { port: number } | null;
      if (!addr || typeof addr.port !== 'number') {
        reject(new Error('Failed to determine server port'));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}`;
      console.log(`\n✓ Serving plot at ${url}`);
      console.log('  Opening in browser…');
      try {
        await openInBrowser(url);
      } catch (err) {
        // Don't reject the promise if we can't open the browser; the server
        // is still serving and the user can open the URL manually.
        console.error(`  ⚠ Could not open browser automatically: ${err}`);
        console.log(`  Please open ${url} manually.`);
      }
    });
  });
}

async function openInBrowser(url: string): Promise<void> {
  const platform = process.platform;

  if (platform === 'win32') {
    await execAsync(`start "" "${url}"`);
  } else if (platform === 'darwin') {
    await execAsync(`open "${url}"`);
  } else {
    await execAsync(`xdg-open "${url}"`);
  }
}

function generateHtml(data: any[], layout: any, config: any): string {
  const dataJson = JSON.stringify(data, null, 2).replace(/<\/script>/gi, '<\\/script>');
  const layoutJson = JSON.stringify(layout, null, 2).replace(/<\/script>/gi, '<\\/script>');
  const configJson = JSON.stringify(config, null, 2).replace(/<\/script>/gi, '<\\/script>');

  const title = layout && layout.title ? String(layout.title) : 'Plot';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <script src="https://cdn.plot.ly/plotly-3.6.0.min.js"></script>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    #plot { width: 100%; height: 800px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div id="plot"></div>
  <script>
    const data = ${dataJson};
    const layout = ${layoutJson};
    const config = ${configJson};
    Plotly.newPlot('plot', data, layout, config);
  </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
