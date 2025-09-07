const express = require('express');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const WebSocket = require('ws');
const Database = require('./database');

class PlaybackServer {
  constructor() {
    this.app = express();
    this.server = null;
    this.wss = null;
    this.db = null;
    this.sessionPath = null;
  }

  async start(sessionPath, port = 3000) {
    this.sessionPath = sessionPath;
    
    // Initialize database
    this.db = new Database(sessionPath);
    await this.db.init();

    // Configure Express
    this.app.use(compression());
    this.app.use(cors());
    this.app.use(express.json());

    // Serve static files (viewer app)
    const viewerPath = path.join(__dirname, '..', 'viewer', 'dist');
    if (require('fs').existsSync(viewerPath)) {
      this.app.use(express.static(viewerPath));
    } else {
      // Fallback to simple viewer
      this.app.use(express.static(path.join(__dirname, 'simple-viewer')));
    }

    // API routes
    this.setupRoutes();

    // Start HTTP server
    this.server = this.app.listen(port, () => {
      console.log(`🌐 Playback server running on http://localhost:${port}`);
    });

    // Setup WebSocket server
    this.wss = new WebSocket.Server({ server: this.server });
    this.setupWebSocket();

    return this.server;
  }

  setupRoutes() {
    // Get session metadata
    this.app.get('/api/session', async (req, res) => {
      try {
        const session = await this.db.get('SELECT * FROM sessions ORDER BY id DESC LIMIT 1');
        res.json(session);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get events in time range
    this.app.get('/api/events', async (req, res) => {
      try {
        const { start, end, type } = req.query;
        let sql = 'SELECT * FROM events WHERE 1=1';
        let params = [];

        if (start) {
          sql += ' AND timestamp >= ?';
          params.push(parseInt(start));
        }
        if (end) {
          sql += ' AND timestamp <= ?';
          params.push(parseInt(end));
        }
        if (type) {
          sql += ' AND type = ?';
          params.push(type);
        }

        sql += ' ORDER BY timestamp, sequence';

        const events = await this.db.all(sql, params);
        res.json(events);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get file content at specific timestamp
    this.app.get('/api/file/:timestamp', async (req, res) => {
      try {
        const { timestamp } = req.params;
        const { path: filePath } = req.query;

        if (!filePath) {
          return res.status(400).json({ error: 'File path required' });
        }

        const fileState = await this.db.getFileStateAtTime(
          1, // Assuming session ID 1 for now
          filePath,
          parseInt(timestamp)
        );

        res.json(fileState);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get timeline overview
    this.app.get('/api/timeline', async (req, res) => {
      try {
        const session = await this.db.get('SELECT * FROM sessions ORDER BY id DESC LIMIT 1');
        const events = await this.db.all(
          'SELECT timestamp, type, COUNT(*) as count FROM events GROUP BY timestamp, type ORDER BY timestamp'
        );
        
        const bookmarks = await this.db.all('SELECT * FROM bookmarks ORDER BY timestamp');

        res.json({
          session,
          events,
          bookmarks,
          startTime: session?.start_time || 0,
          endTime: session?.end_time || Date.now()
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get file list
    this.app.get('/api/files', async (req, res) => {
      try {
        const files = await this.db.all(
          'SELECT DISTINCT file_path, COUNT(*) as changes FROM file_snapshots GROUP BY file_path ORDER BY file_path'
        );
        res.json(files);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get file content at specific timestamp
    this.app.get('/api/file-content/:timestamp', async (req, res) => {
      try {
        const { timestamp } = req.params;
        const { file_path } = req.query;

        if (!file_path) {
          res.status(400).json({ error: 'file_path parameter required' });
          return;
        }

        // Get the most recent snapshot before or at the timestamp
        const snapshot = await this.db.get(
          'SELECT * FROM file_snapshots WHERE file_path = ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT 1',
          [file_path, parseInt(timestamp)]
        );

        res.json({ snapshot });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get all file snapshots for a file (to show history)
    this.app.get('/api/file-history/:file_path', async (req, res) => {
      try {
        const { file_path } = req.params;
        const snapshots = await this.db.all(
          'SELECT timestamp, content_hash, size FROM file_snapshots WHERE file_path = ? ORDER BY timestamp',
          [decodeURIComponent(file_path)]
        );
        res.json(snapshots);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Debug endpoint - show all file snapshots
    this.app.get('/api/debug/snapshots', async (req, res) => {
      try {
        const snapshots = await this.db.all('SELECT * FROM file_snapshots ORDER BY timestamp');
        res.json({ count: snapshots.length, snapshots });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Fallback route for SPA
    this.app.get('*', (req, res) => {
      const indexPath = path.join(__dirname, 'simple-viewer', 'index.html');
      if (require('fs').existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.send(this.generateSimpleViewer());
      }
    });
  }

  setupWebSocket() {
    this.wss.on('connection', (ws) => {
      console.log('Client connected to WebSocket');

      ws.on('message', async (message) => {
        try {
          console.log('Received WebSocket message from client:', message.toString());
          const data = JSON.parse(message);
          console.log('Parsed message data:', data);
          
          switch (data.type) {
            case 'seek':
              console.log('Handling seek to timestamp:', data.timestamp);
              await this.handleSeek(ws, data.timestamp);
              break;
            case 'play':
              console.log('Handling play from startTime:', data.startTime, 'at speed:', data.speed);
              await this.handlePlay(ws, data.startTime, data.speed);
              break;
            case 'pause':
              console.log('Handling pause');
              this.handlePause(ws);
              break;
            default:
              console.log('Unknown message type:', data.type);
          }
        } catch (error) {
          console.error('Error handling WebSocket message:', error);
          ws.send(JSON.stringify({ type: 'error', message: error.message }));
        }
      });

      ws.on('close', () => {
        console.log('Client disconnected from WebSocket');
      });
    });
  }

  async handleSeek(ws, timestamp) {
    // Get events at specific timestamp
    const events = await this.db.getEventsInRange(1, timestamp - 1000, timestamp + 1000);
    
    ws.send(JSON.stringify({
      type: 'seek_result',
      timestamp,
      events
    }));
  }

  async handlePlay(ws, startTime, speed = 1) {
    console.log(`Starting playback from ${startTime} at ${speed}x speed`);
    
    // Stream events from startTime
    const session = await this.db.get('SELECT * FROM sessions ORDER BY id DESC LIMIT 1');
    if (!session) {
      console.error('No session found');
      ws.send(JSON.stringify({ type: 'error', message: 'No session found' }));
      return;
    }
    
    const endTime = session.end_time || Date.now();
    console.log(`Session found: ${session.id}, endTime: ${endTime}`);

    const events = await this.db.getEventsInRange(session.id, startTime, endTime);
    console.log(`Found ${events.length} events to play`);

    let currentTime = startTime;
    let eventIndex = 0;

    const playInterval = setInterval(() => {
      while (eventIndex < events.length && events[eventIndex].timestamp <= currentTime) {
        console.log(`Sending event ${eventIndex + 1}/${events.length}:`, events[eventIndex]);
        ws.send(JSON.stringify({
          type: 'event',
          event: events[eventIndex]
        }));
        eventIndex++;
      }

      currentTime += 100 * speed; // 100ms intervals

      if (currentTime > endTime || eventIndex >= events.length) {
        console.log('Playback complete');
        clearInterval(playInterval);
        ws.send(JSON.stringify({ type: 'playback_complete' }));
      }
    }, 100);

    // Store interval for pause functionality
    ws.playInterval = playInterval;
  }

  handlePause(ws) {
    if (ws.playInterval) {
      clearInterval(ws.playInterval);
      delete ws.playInterval;
    }
  }

  generateSimpleViewer() {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CodeTimeMachine Player</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; margin: 0; padding: 20px; }
        .header { border-bottom: 1px solid #eee; margin-bottom: 20px; padding-bottom: 10px; }
        .timeline { margin: 20px 0; }
        .timeline input { width: 100%; }
        .controls { margin: 20px 0; }
        .controls button { margin-right: 10px; padding: 8px 16px; }
        .content { display: flex; }
        .file-list { width: 200px; border-right: 1px solid #eee; padding-right: 20px; }
        .main-area { flex: 1; margin-left: 20px; }
        .editor { margin-bottom: 20px; }
        .file-viewer { background: #f9f9f9; border: 1px solid #ddd; padding: 15px; margin-bottom: 20px; min-height: 300px; font-family: monospace; }
        .event-log { background: #f5f5f5; padding: 10px; font-family: monospace; font-size: 12px; height: 200px; overflow-y: auto; }
        .event { margin: 2px 0; }
        .event.file_edit { color: #0066cc; }
        .event.terminal { color: #cc6600; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🎬 CodeTimeMachine Player</h1>
        <div id="session-info">Loading session...</div>
    </div>

    <div class="timeline">
        <input type="range" id="timeline-slider" min="0" max="100" value="0">
        <div id="timeline-info">Time: 0s / 0s</div>
    </div>

    <div class="controls">
        <button onclick="play()">▶️ Play</button>
        <button onclick="pause()">⏸️ Pause</button>
        <button onclick="seek()">🎯 Seek</button>
        <select id="speed">
            <option value="0.5">0.5x</option>
            <option value="1" selected>1x</option>
            <option value="2">2x</option>
            <option value="4">4x</option>
        </select>
    </div>

    <div class="content">
        <div class="file-list">
            <h3>Files</h3>
            <div id="files">Loading...</div>
        </div>

        <div class="main-area">
            <div class="editor">
                <h3>File Viewer</h3>
                <div class="file-viewer" id="file-viewer">
                    <div style="color: #666;">Select a file from the list or start playback to see file changes</div>
                </div>
            </div>
            
            <div class="events-section">
                <h3>Events</h3>
                <div class="event-log" id="events"></div>
            </div>
        </div>
    </div>

    <script>
        let ws = null;
        let sessionData = null;
        let currentTimestamp = 0;

        async function init() {
            // Connect WebSocket
            const port = window.location.port || '3001';
            ws = new WebSocket('ws://localhost:' + port);
            
            ws.onopen = () => {
                console.log('WebSocket connected successfully!');
            };
            
            ws.onerror = (error) => {
                console.error('WebSocket error:', error);
            };
            
            ws.onclose = () => {
                console.log('WebSocket connection closed');
            };
            
            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                console.log('Received WebSocket message:', data);
                handleWebSocketMessage(data);
            };

            // Load session data
            const response = await fetch('/api/session');
            sessionData = await response.json();
            
            document.getElementById('session-info').textContent = 
                \`Project: \${sessionData.project_path} | Started: \${new Date(sessionData.start_time).toLocaleString()}\`;

            // Load timeline
            await loadTimeline();
            
            // Load files
            await loadFiles();
        }

        async function loadTimeline() {
            const response = await fetch('/api/timeline');
            const timeline = await response.json();
            
            const slider = document.getElementById('timeline-slider');
            slider.min = timeline.startTime;
            slider.max = timeline.endTime;
            slider.value = timeline.startTime;
            
            updateTimelineInfo();
        }

        async function loadFiles() {
            const response = await fetch('/api/files');
            const files = await response.json();
            
            const filesDiv = document.getElementById('files');
            filesDiv.innerHTML = files.map(f => 
                \`<div onclick="selectFile('\${f.file_path}')" style="cursor: pointer; padding: 5px; border: 1px solid #ddd; margin: 2px 0; background: #fff;">
                    <strong>\${f.file_path}</strong><br>
                    <small>\${f.changes} changes</small>
                </div>\`
            ).join('');
        }

        function handleWebSocketMessage(data) {
            console.log('Handling WebSocket message:', data);
            const eventsDiv = document.getElementById('events');
            
            switch (data.type) {
                case 'event':
                    console.log('Adding event to display:', data.event);
                    const eventDiv = document.createElement('div');
                    eventDiv.className = \`event \${data.event.type}\`;
                    eventDiv.innerHTML = \`
                        <strong>[\${new Date(data.event.timestamp).toLocaleTimeString()}]</strong> 
                        <span style="color: #0066cc;">\${data.event.type}</span>: 
                        <code>\${data.event.source}</code>
                        <br><small style="color: #666;">Data: \${data.event.data}</small>
                    \`;
                    eventsDiv.appendChild(eventDiv);
                    eventsDiv.scrollTop = eventsDiv.scrollHeight;
                    
                    // Flash the events panel to show activity
                    eventsDiv.style.backgroundColor = '#ffff99';
                    setTimeout(() => {
                        eventsDiv.style.backgroundColor = '#f5f5f5';
                    }, 200);
                    
                    // If it's a file edit, load and show the file content
                    if (data.event.type === 'file_edit') {
                        showFileContent(data.event.source, data.event.timestamp);
                    }
                    break;
                    
                case 'seek_result':
                    console.log('Displaying seek results:', data.events.length, 'events');
                    eventsDiv.innerHTML = '';
                    data.events.forEach(event => {
                        const eventDiv = document.createElement('div');
                        eventDiv.className = \`event \${event.type}\`;
                        eventDiv.innerHTML = \`
                            <strong>[\${new Date(event.timestamp).toLocaleTimeString()}]</strong> 
                            <span style="color: #0066cc;">\${event.type}</span>: 
                            <code>\${event.source}</code>
                            <br><small style="color: #666;">Data: \${event.data}</small>
                        \`;
                        eventsDiv.appendChild(eventDiv);
                    });
                    break;
                    
                case 'playback_complete':
                    console.log('Playback completed!');
                    eventsDiv.innerHTML += '<div style="color: green; font-weight: bold; margin-top: 10px;">🎬 Playback Complete!</div>';
                    break;
                    
                case 'error':
                    console.error('Server error:', data.message);
                    eventsDiv.innerHTML += \`<div style="color: red; font-weight: bold;">❌ Error: \${data.message}</div>\`;
                    break;
            }
        }

        function play() {
            console.log('Play button clicked!');
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                console.error('WebSocket is not connected!');
                alert('WebSocket not connected. Refresh the page and try again.');
                return;
            }
            
            // Clear previous events and show playing status
            const eventsDiv = document.getElementById('events');
            eventsDiv.innerHTML = '<div style="color: blue; font-weight: bold;">▶️ Starting playback...</div>';
            
            const slider = document.getElementById('timeline-slider');
            const speed = document.getElementById('speed').value;
            const message = {
                type: 'play',
                startTime: parseInt(slider.value),
                speed: parseFloat(speed)
            };
            
            console.log('Sending play message:', message);
            ws.send(JSON.stringify(message));
        }

        function pause() {
            ws.send(JSON.stringify({ type: 'pause' }));
        }

        function seek() {
            const slider = document.getElementById('timeline-slider');
            ws.send(JSON.stringify({
                type: 'seek',
                timestamp: parseInt(slider.value)
            }));
        }

        function updateTimelineInfo() {
            const slider = document.getElementById('timeline-slider');
            const current = new Date(parseInt(slider.value));
            const end = new Date(parseInt(slider.max));
            const duration = (parseInt(slider.max) - parseInt(slider.min)) / 1000;
            const progress = ((parseInt(slider.value) - parseInt(slider.min)) / (parseInt(slider.max) - parseInt(slider.min)) * 100).toFixed(1);
            
            document.getElementById('timeline-info').innerHTML = 
                \`<strong>Time:</strong> \${current.toLocaleTimeString()} / \${end.toLocaleTimeString()}<br>
                 <strong>Duration:</strong> \${duration}s | <strong>Progress:</strong> \${progress}%\`;
        }

        async function selectFile(filePath) {
            console.log('Selected file:', filePath);
            const slider = document.getElementById('timeline-slider');
            const timestamp = parseInt(slider.value);
            await showFileContent(filePath, timestamp);
        }

        async function showFileContent(filePath, timestamp) {
            try {
                console.log('Loading file content for:', filePath, 'at timestamp:', timestamp);
                const response = await fetch(\`/api/file-content/\${timestamp}?file_path=\${encodeURIComponent(filePath)}\`);
                const data = await response.json();
                
                const fileViewer = document.getElementById('file-viewer');
                
                if (data.snapshot && data.snapshot.content) {
                    const lines = data.snapshot.content.split('\\n');
                    const numberedContent = lines.map((line, index) => 
                        \`<span style="color: #666; margin-right: 10px;">\${(index + 1).toString().padStart(3, ' ')}</span><span>\${line}</span>\`
                    ).join('<br>');
                    
                    fileViewer.innerHTML = \`
                        <div style="background: #e8e8e8; padding: 10px; margin-bottom: 10px; border-radius: 3px;">
                            <strong>📁 \${filePath}</strong><br>
                            <small>Content at \${new Date(timestamp).toLocaleString()}</small><br>
                            <small>Size: \${data.snapshot.size} bytes | Hash: \${data.snapshot.content_hash.substring(0, 8)}...</small>
                        </div>
                        <div style="background: white; padding: 10px; border: 1px solid #ddd; font-family: 'Courier New', monospace; white-space: pre-wrap;">
                            \${numberedContent}
                        </div>
                    \`;
                } else {
                    fileViewer.innerHTML = \`
                        <div style="color: #999; text-align: center; padding: 50px;">
                            No file content available for <strong>\${filePath}</strong> at this time
                        </div>
                    \`;
                }
            } catch (error) {
                console.error('Error loading file content:', error);
                document.getElementById('file-viewer').innerHTML = \`
                    <div style="color: red;">Error loading file: \${error.message}</div>
                \`;
            }
        }

        document.getElementById('timeline-slider').addEventListener('input', updateTimelineInfo);

        init();
    </script>
</body>
</html>`;
  }

  async stop() {
    if (this.wss) {
      this.wss.close();
    }
    if (this.server) {
      this.server.close();
    }
    if (this.db) {
      await this.db.close();
    }
  }
}

module.exports = {
  start: (sessionPath, port) => {
    const server = new PlaybackServer();
    return server.start(sessionPath, port);
  }
};