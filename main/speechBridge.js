const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Security: Generate random port and token for each session
const WS_PORT = 49152 + Math.floor(Math.random() * 10000); // Random port in safe range
const HTTP_PORT = WS_PORT + 1;
const SESSION_TOKEN = crypto.randomBytes(32).toString('hex');

let wss = null;
let httpServer = null;
let connectedClient = null;
let onTranscriptCallback = null;
let onReadyCallback = null;
let onErrorCallback = null;

function startServers() {
  return new Promise((resolve, reject) => {
    // HTTP server to serve the speech service page with token
    httpServer = http.createServer((req, res) => {
      // Only serve index.html with token parameter
      const url = new URL(req.url, `http://127.0.0.1:${HTTP_PORT}`);

      if (url.pathname === '/' || url.pathname === '/index.html') {
        const templatePath = path.join(__dirname, '../speech-service/index.html');

        fs.readFile(templatePath, 'utf8', (err, data) => {
          if (err) {
            res.writeHead(404);
            res.end('Not found');
          } else {
            // Inject configuration into the page
            const injectedHtml = data.replace(
              '<!-- CONFIG_PLACEHOLDER -->',
              `<script>
                                window.DICTATOR_CONFIG = {
                                    WS_PORT: ${WS_PORT},
                                    TOKEN: "${SESSION_TOKEN}"
                                };
                            </script>`
            );
            res.writeHead(200, {
              'Content-Type': 'text/html',
              'Cache-Control': 'no-store'
            });
            res.end(injectedHtml);
          }
        });
      } else if (url.pathname === '/logo.png' || url.pathname === '/Schribe.png') {
        const logoPath = path.join(__dirname, '../assets/Schribe.png');
        fs.readFile(logoPath, (err, data) => {
          if (err) {
            res.writeHead(404);
            res.end('Not found');
          } else {
            res.writeHead(200, { 'Content-Type': 'image/png' });
            res.end(data);
          }
        });
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    // Bind to localhost ONLY - no external exposure
    httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
      console.log(`Speech service: http://127.0.0.1:${HTTP_PORT}`);
    });

    // WebSocket server - localhost only
    wss = new WebSocketServer({
      port: WS_PORT,
      host: '127.0.0.1',
      clientTracking: true
    });

    wss.on('listening', () => {
      console.log(`WebSocket server: ws://127.0.0.1:${WS_PORT}`);
      console.log(`Session token: ${SESSION_TOKEN.substring(0, 8)}...`);
      resolve();
    });

    wss.on('connection', (ws, req) => {
      console.log('New connection attempt');

      // Token validation state
      let authenticated = false;

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());

          // First message must be auth with valid token
          if (!authenticated) {
            if (msg.type === 'auth' && msg.token === SESSION_TOKEN) {
              authenticated = true;
              connectedClient = ws;
              console.log('Speech service authenticated');
              ws.send(JSON.stringify({ type: 'auth_ok' }));
              if (onReadyCallback) onReadyCallback();
            } else {
              console.error('Invalid token, closing connection');
              ws.close(4001, 'Invalid token');
            }
            return;
          }

          // Handle authenticated messages
          if (msg.type === 'FINAL_RESULT') {
            console.log('FINAL_RESULT received:', msg.text?.substring(0, 50) + '...');
            if (onTranscriptCallback) onTranscriptCallback(msg.text);
          } else if (msg.type === 'transcript') {
            console.log('Received transcript:', msg.text?.substring(0, 50) + '...');
            if (onTranscriptCallback) onTranscriptCallback(msg.text);
          } else if (msg.type === 'error') {
            console.error('Speech error:', msg.error);
            if (onErrorCallback) onErrorCallback(msg.error);
          }
        } catch (e) {
          console.error('Parse error:', e);
        }
      });

      ws.on('close', () => {
        if (ws === connectedClient) {
          console.log('Speech service disconnected');
          connectedClient = null;
        }
      });

      ws.on('error', (err) => {
        console.error('WebSocket client error:', err);
      });

      // Close unauthenticated connections after 5 seconds
      setTimeout(() => {
        if (!authenticated) {
          console.log('Connection timeout - no auth');
          ws.close(4002, 'Auth timeout');
        }
      }, 5000);
    });

    wss.on('error', (err) => {
      console.error('WebSocket server error:', err);
      reject(err);
    });
  });
}

function stopServers() {
  if (wss) {
    wss.close();
    wss = null;
  }
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
  connectedClient = null;
}

function isConnected() {
  return connectedClient !== null && connectedClient.readyState === 1;
}

function sendCommand(type) {
  if (connectedClient && connectedClient.readyState === 1) {
    connectedClient.send(JSON.stringify({ type }));
    return true;
  }
  return false;
}

function startRecording() {
  return sendCommand('start');
}

function stopRecording() {
  return sendCommand('stop');
}

function onTranscript(callback) {
  onTranscriptCallback = callback;
}

function onReady(callback) {
  onReadyCallback = callback;
}

function onError(callback) {
  onErrorCallback = callback;
}

function getSpeechServiceUrl() {
  return `http://127.0.0.1:${HTTP_PORT}`;
}

module.exports = {
  startServers,
  stopServers,
  isConnected,
  startRecording,
  stopRecording,
  onTranscript,
  onReady,
  onError,
  getSpeechServiceUrl
};
