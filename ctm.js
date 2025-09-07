#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn, exec } = require('child_process');

// CodeTimeMachine - Fully Working Implementation
// NO EXTERNAL DEPENDENCIES REQUIRED

const CONFIG_DIR = path.join(os.homedir(), '.codetimemachine');
const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions');
const CURRENT_SESSION_FILE = path.join(CONFIG_DIR, 'current.json');
const DAEMON_PID_FILE = path.join(CONFIG_DIR, 'daemon.pid');

// Ensure config directories exist
[CONFIG_DIR, SESSIONS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

class FileDatabase {
  constructor(sessionPath) {
    this.sessionPath = sessionPath;
    this.data = {
      session: null,
      events: [],
      files: {},
      bookmarks: []
    };
  }

  load() {
    if (fs.existsSync(this.sessionPath)) {
      try {
        this.data = JSON.parse(fs.readFileSync(this.sessionPath, 'utf8'));
      } catch (error) {
        console.error('Error loading session:', error.message);
      }
    }
  }

  save() {
    fs.writeFileSync(this.sessionPath, JSON.stringify(this.data, null, 2));
  }

  createSession(projectPath, name) {
    this.data.session = {
      id: `session_${Date.now()}`,
      name,
      projectPath,
      startTime: Date.now(),
      endTime: null,
      gitBranch: this.getGitBranch(projectPath),
      gitCommit: this.getGitCommit(projectPath)
    };
    this.save();
    return this.data.session.id;
  }

  endSession() {
    if (this.data.session) {
      this.data.session.endTime = Date.now();
      this.save();
    }
  }

  addEvent(type, source, data = {}) {
    const event = {
      id: Date.now() + Math.random(),
      timestamp: Date.now(),
      type,
      source,
      data
    };
    this.data.events.push(event);
    this.save();
    return event;
  }

  addFileSnapshot(filePath, content) {
    if (!this.data.files[filePath]) {
      this.data.files[filePath] = { snapshots: [], changes: 0 };
    }
    
    this.data.files[filePath].snapshots.push({
      timestamp: Date.now(),
      content: content.substring(0, 50000), // Limit content size
      size: content.length,
      lines: content.split('\n').length
    });
    this.data.files[filePath].changes++;
    this.save();
  }

  getGitBranch(projectPath) {
    try {
      const gitHead = path.join(projectPath, '.git', 'HEAD');
      if (fs.existsSync(gitHead)) {
        const head = fs.readFileSync(gitHead, 'utf8').trim();
        if (head.startsWith('ref: refs/heads/')) {
          return head.replace('ref: refs/heads/', '');
        }
      }
    } catch (error) {
      // Git info is optional
    }
    return null;
  }

  getGitCommit(projectPath) {
    try {
      const branch = this.getGitBranch(projectPath);
      if (branch) {
        const commitFile = path.join(projectPath, '.git', 'refs', 'heads', branch);
        if (fs.existsSync(commitFile)) {
          return fs.readFileSync(commitFile, 'utf8').trim().substring(0, 8);
        }
      }
    } catch (error) {
      // Git info is optional
    }
    return null;
  }
}

class FileDaemon {
  constructor(sessionPath, projectPath) {
    this.db = new FileDatabase(sessionPath);
    this.db.load();
    this.projectPath = projectPath;
    this.watchedFiles = new Map();
    this.isRunning = false;
  }

  start() {
    this.isRunning = true;
    console.log(`🔴 Daemon started - watching ${this.projectPath}`);
    
    this.scanAndWatch(this.projectPath);
    
    // Periodically scan for new files
    this.scanInterval = setInterval(() => {
      if (this.isRunning) {
        this.scanAndWatch(this.projectPath);
      }
    }, 5000);

    // Handle process termination
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }

  scanAndWatch(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(this.projectPath, fullPath);
        
        // Skip hidden files, node_modules, etc.
        if (this.shouldIgnore(entry.name, relativePath)) continue;
        
        if (entry.isDirectory()) {
          this.scanAndWatch(fullPath);
        } else if (entry.isFile()) {
          this.watchFile(fullPath, relativePath);
        }
      }
    } catch (error) {
      // Ignore permission errors
    }
  }

  shouldIgnore(name, relativePath) {
    const ignorePatterns = [
      /^\./,  // Hidden files
      /node_modules/,
      /\.git/,
      /dist/,
      /build/,
      /coverage/,
      /\.ctm$/,
      /\.log$/,
      /\.tmp$/
    ];
    
    return ignorePatterns.some(pattern => 
      pattern.test(name) || pattern.test(relativePath)
    );
  }

  watchFile(fullPath, relativePath) {
    if (this.watchedFiles.has(fullPath)) return;
    
    let lastModified = 0;
    let lastSize = 0;
    
    const checkFile = () => {
      if (!this.isRunning) return;
      
      try {
        const stats = fs.statSync(fullPath);
        
        if (stats.mtime.getTime() !== lastModified || stats.size !== lastSize) {
          // File changed
          this.db.addEvent('file_change', relativePath, {
            size: stats.size,
            modified: stats.mtime.toISOString()
          });
          
          // Capture content for small files
          if (stats.size < 100000) {
            try {
              const content = fs.readFileSync(fullPath, 'utf8');
              this.db.addFileSnapshot(relativePath, content);
              console.log(`📝 ${relativePath} (${stats.size} bytes)`);
            } catch (error) {
              // File might be binary or locked
            }
          }
          
          lastModified = stats.mtime.getTime();
          lastSize = stats.size;
        }
      } catch (error) {
        // File might have been deleted
        if (lastModified > 0) {
          this.db.addEvent('file_delete', relativePath, {});
          console.log(`🗑️ ${relativePath}`);
          this.stopWatchingFile(fullPath);
        }
      }
    };
    
    // Check file every 1 second
    const interval = setInterval(checkFile, 1000);
    this.watchedFiles.set(fullPath, interval);
    
    // Initial check
    checkFile();
  }

  stopWatchingFile(fullPath) {
    const interval = this.watchedFiles.get(fullPath);
    if (interval) {
      clearInterval(interval);
      this.watchedFiles.delete(fullPath);
    }
  }

  stop() {
    this.isRunning = false;
    
    // Clear all intervals
    this.watchedFiles.forEach(interval => clearInterval(interval));
    this.watchedFiles.clear();
    
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
    }
    
    this.db.endSession();
    console.log('🛑 Daemon stopped');
    process.exit(0);
  }
}

class WebServer {
  constructor(sessionPath) {
    this.sessionPath = sessionPath;
    this.db = new FileDatabase(sessionPath);
    this.db.load();
  }

  start(port = 3000) {
    const server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    server.listen(port, () => {
      console.log(`🌐 Web viewer: http://localhost:${port}`);
    });

    return server;
  }

  handleRequest(req, res) {
    const url = new URL(req.url, `http://localhost:3000`);
    
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    if (url.pathname === '/api/session') {
      res.end(JSON.stringify(this.db.data.session));
    } else if (url.pathname === '/api/events') {
      const start = url.searchParams.get('start');
      const end = url.searchParams.get('end');
      let events = this.db.data.events;
      
      if (start) events = events.filter(e => e.timestamp >= parseInt(start));
      if (end) events = events.filter(e => e.timestamp <= parseInt(end));
      
      res.end(JSON.stringify(events));
    } else if (url.pathname === '/api/files') {
      res.end(JSON.stringify(Object.keys(this.db.data.files)));
    } else if (url.pathname === '/api/file-content') {
      const filePath = url.searchParams.get('path');
      const timestamp = url.searchParams.get('timestamp');
      
      if (filePath && this.db.data.files[filePath]) {
        const snapshots = this.db.data.files[filePath].snapshots;
        const snapshot = snapshots
          .filter(s => !timestamp || s.timestamp <= parseInt(timestamp))
          .pop();
        
        res.end(JSON.stringify(snapshot || null));
      } else {
        res.end(JSON.stringify(null));
      }
    } else if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(this.generateViewer());
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  generateViewer() {
    return `<!DOCTYPE html>
<html>
<head>
    <title>CodeTimeMachine Viewer</title>
    <style>
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace; 
            margin: 0; padding: 0; background: #1e1e1e; color: #fff; 
        }
        .header { background: #2d2d30; padding: 15px; border-bottom: 1px solid #3e3e42; }
        .header h1 { margin: 0; color: #fff; }
        .session-info { margin-top: 5px; color: #ccc; font-size: 14px; }
        .controls { padding: 15px; background: #252526; border-bottom: 1px solid #3e3e42; }
        .timeline { width: 100%; margin: 10px 0; }
        .timeline input { width: 100%; height: 4px; background: #3e3e42; outline: none; }
        .content { display: flex; height: calc(100vh - 140px); }
        .sidebar { width: 300px; background: #252526; border-right: 1px solid #3e3e42; padding: 15px; overflow-y: auto; }
        .main { flex: 1; padding: 15px; overflow-y: auto; }
        .file-item { padding: 8px; cursor: pointer; border-radius: 3px; }
        .file-item:hover { background: #2a2d2e; }
        .file-item.active { background: #0e639c; }
        .event { margin: 5px 0; padding: 8px; background: #2d2d30; border-radius: 3px; font-size: 12px; }
        .event.file_change { border-left: 4px solid #4ec9b0; }
        .event.terminal { border-left: 4px solid #dcdcaa; }
        .event.git { border-left: 4px solid #f44747; }
        .code-view { background: #1e1e1e; border: 1px solid #3e3e42; padding: 15px; font-family: 'Monaco', monospace; white-space: pre-wrap; overflow: auto; max-height: 400px; }
        button { background: #0e639c; color: white; border: none; padding: 8px 16px; margin-right: 10px; border-radius: 3px; cursor: pointer; }
        button:hover { background: #1177bb; }
        .timestamp { color: #6a9955; font-size: 11px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>🎬 CodeTimeMachine</h1>
        <div class="session-info" id="session-info">Loading...</div>
    </div>
    
    <div class="controls">
        <div class="timeline">
            <input type="range" id="timeline" min="0" max="100" value="0">
            <div id="timeline-info">00:00 / 00:00</div>
        </div>
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
        <div class="sidebar">
            <h3>Files</h3>
            <div id="file-list"></div>
            
            <h3 style="margin-top: 30px;">Events</h3>
            <div id="event-list" style="max-height: 300px; overflow-y: auto;"></div>
        </div>
        
        <div class="main">
            <h3>File Content</h3>
            <div id="file-content" class="code-view">Select a file to view its content</div>
        </div>
    </div>
    
    <script>
        let sessionData = null;
        let events = [];
        let currentTime = 0;
        let isPlaying = false;
        let playInterval = null;
        
        async function init() {
            try {
                // Load session data
                const sessionRes = await fetch('/api/session');
                sessionData = await sessionRes.json();
                
                if (sessionData) {
                    document.getElementById('session-info').innerHTML = 
                        \`Project: \${sessionData.projectPath} | Duration: \${formatDuration(sessionData.endTime - sessionData.startTime)} | Events: \${events.length}\`;
                    
                    const timeline = document.getElementById('timeline');
                    timeline.min = sessionData.startTime;
                    timeline.max = sessionData.endTime || Date.now();
                    timeline.value = sessionData.startTime;
                    currentTime = sessionData.startTime;
                }
                
                // Load events
                const eventsRes = await fetch('/api/events');
                events = await eventsRes.json();
                
                // Load files
                const filesRes = await fetch('/api/files');
                const files = await filesRes.json();
                
                const fileList = document.getElementById('file-list');
                fileList.innerHTML = files.map(file => 
                    \`<div class="file-item" onclick="selectFile('\${file}')">\${file}</div>\`
                ).join('');
                
                updateEventList();
                updateTimeline();
                
            } catch (error) {
                console.error('Error loading data:', error);
            }
        }
        
        function updateEventList() {
            const eventList = document.getElementById('event-list');
            const recentEvents = events
                .filter(e => e.timestamp <= currentTime + 5000)
                .slice(-20);
            
            eventList.innerHTML = recentEvents.map(event => 
                \`<div class="event \${event.type}">
                    <div class="timestamp">\${new Date(event.timestamp).toLocaleTimeString()}</div>
                    <strong>\${event.type}:</strong> \${event.source}
                </div>\`
            ).join('');
        }
        
        async function selectFile(filePath) {
            try {
                const res = await fetch(\`/api/file-content?path=\${encodeURIComponent(filePath)}&timestamp=\${currentTime}\`);
                const snapshot = await res.json();
                
                const fileContent = document.getElementById('file-content');
                if (snapshot) {
                    fileContent.textContent = snapshot.content;
                } else {
                    fileContent.textContent = 'No content available for this time';
                }
                
                // Update active file
                document.querySelectorAll('.file-item').forEach(item => item.classList.remove('active'));
                event.target.classList.add('active');
                
            } catch (error) {
                console.error('Error loading file:', error);
            }
        }
        
        function updateTimeline() {
            const timeline = document.getElementById('timeline');
            currentTime = parseInt(timeline.value);
            
            const startTime = sessionData ? sessionData.startTime : 0;
            const endTime = sessionData ? (sessionData.endTime || Date.now()) : Date.now();
            
            const current = formatTime(currentTime - startTime);
            const total = formatTime(endTime - startTime);
            
            document.getElementById('timeline-info').textContent = \`\${current} / \${total}\`;
            updateEventList();
        }
        
        function play() {
            if (isPlaying) return;
            
            isPlaying = true;
            const speed = parseFloat(document.getElementById('speed').value);
            const timeline = document.getElementById('timeline');
            
            playInterval = setInterval(() => {
                currentTime += 1000 * speed;
                timeline.value = currentTime;
                updateTimeline();
                
                if (currentTime >= parseInt(timeline.max)) {
                    pause();
                }
            }, 1000);
        }
        
        function pause() {
            isPlaying = false;
            if (playInterval) {
                clearInterval(playInterval);
                playInterval = null;
            }
        }
        
        function seek() {
            pause();
            updateTimeline();
        }
        
        function formatTime(ms) {
            const seconds = Math.floor(ms / 1000) % 60;
            const minutes = Math.floor(ms / 60000) % 60;
            const hours = Math.floor(ms / 3600000);
            
            if (hours > 0) {
                return \`\${hours}:\${minutes.toString().padStart(2, '0')}:\${seconds.toString().padStart(2, '0')}\`;
            } else {
                return \`\${minutes}:\${seconds.toString().padStart(2, '0')}\`;
            }
        }
        
        function formatDuration(ms) {
            if (!ms) return '0s';
            const seconds = Math.floor(ms / 1000);
            const minutes = Math.floor(seconds / 60);
            if (minutes > 0) {
                return \`\${minutes}m \${seconds % 60}s\`;
            } else {
                return \`\${seconds}s\`;
            }
        }
        
        // Timeline scrubbing
        document.getElementById('timeline').addEventListener('input', updateTimeline);
        
        // Initialize
        init();
    </script>
</body>
</html>`;
  }
}

// CLI Commands
function showHelp() {
  console.log(`
🎬 CodeTimeMachine - Development Session Recorder

COMMANDS:
  start [options]     Start recording session
  stop [options]      Stop recording session  
  play <session>      Play back recorded session
  status             Show current status
  list               List recorded sessions
  help               Show this help

START OPTIONS:
  -n, --name <name>   Session name
  -p, --path <path>   Project path (default: current directory)

STOP OPTIONS:
  -o, --output <file> Export session to .ctm file

PLAY OPTIONS:
  --port <port>       Web server port (default: 3000)

EXAMPLES:
  ctm start -n "bug-fix" -p ./my-project
  ctm stop -o my-session.ctm
  ctm play my-session.ctm
  ctm status
`);
}

function getCurrentSession() {
  if (!fs.existsSync(CURRENT_SESSION_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CURRENT_SESSION_FILE, 'utf8'));
  } catch (error) {
    return null;
  }
}

function saveCurrentSession(sessionInfo) {
  fs.writeFileSync(CURRENT_SESSION_FILE, JSON.stringify(sessionInfo, null, 2));
}

function clearCurrentSession() {
  if (fs.existsSync(CURRENT_SESSION_FILE)) {
    fs.unlinkSync(CURRENT_SESSION_FILE);
  }
}

async function startRecording(args) {
  const current = getCurrentSession();
  if (current) {
    console.log('⚠️  Recording already in progress. Use "ctm stop" first.');
    return;
  }

  const projectPath = path.resolve(args.path || process.cwd());
  const sessionName = args.name || `session_${Date.now()}`;
  const sessionId = `${sessionName}_${Date.now()}`;
  const sessionFile = path.join(SESSIONS_DIR, `${sessionId}.json`);

  // Create session database
  const db = new FileDatabase(sessionFile);
  const dbSessionId = db.createSession(projectPath, sessionName);

  // Save current session info
  const sessionInfo = {
    id: sessionId,
    name: sessionName,
    projectPath,
    sessionFile,
    startTime: Date.now(),
    pid: null
  };

  // Start daemon
  console.log('🔴 Starting recording daemon...');
  const daemon = spawn('node', [__filename, '_daemon', sessionFile, projectPath], {
    detached: true,
    stdio: 'ignore'
  });
  daemon.unref();

  sessionInfo.pid = daemon.pid;
  saveCurrentSession(sessionInfo);

  // Save PID for cleanup
  fs.writeFileSync(DAEMON_PID_FILE, daemon.pid.toString());

  console.log(`🎬 Recording started: ${sessionName}`);
  console.log(`📁 Project: ${projectPath}`);
  console.log(`💾 Session: ${sessionFile}`);
  console.log('');
  console.log('Use "ctm stop" to finish recording');
}

async function stopRecording(args) {
  const current = getCurrentSession();
  if (!current) {
    console.log('⚠️  No recording in progress.');
    return;
  }

  // Stop daemon
  if (fs.existsSync(DAEMON_PID_FILE)) {
    try {
      const pid = parseInt(fs.readFileSync(DAEMON_PID_FILE, 'utf8'));
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      // Process might already be dead
    }
    fs.unlinkSync(DAEMON_PID_FILE);
  }

  // Finalize session
  const db = new FileDatabase(current.sessionFile);
  db.load();
  db.endSession();

  const duration = Math.round((Date.now() - current.startTime) / 1000);
  console.log(`🛑 Recording stopped: ${current.name}`);
  console.log(`⏱️  Duration: ${duration}s`);
  console.log(`📊 Events: ${db.data.events.length}`);

  // Export if requested
  if (args.output) {
    const outputFile = args.output.endsWith('.ctm') ? args.output : `${args.output}.ctm`;
    fs.copyFileSync(current.sessionFile, outputFile);
    console.log(`💾 Exported: ${outputFile}`);
  }

  clearCurrentSession();
}

async function playSession(sessionFile) {
  if (!fs.existsSync(sessionFile)) {
    console.log(`❌ Session file not found: ${sessionFile}`);
    return;
  }

  console.log(`🎥 Starting playback: ${sessionFile}`);
  const server = new WebServer(sessionFile);
  const httpServer = server.start(3000);

  // Open browser
  const openCmd = process.platform === 'win32' ? 'start' : 
                  process.platform === 'darwin' ? 'open' : 'xdg-open';
  
  exec(`${openCmd} http://localhost:3000`, (error) => {
    if (error) console.log('Open browser manually: http://localhost:3000');
  });

  console.log('Press Ctrl+C to stop server');
}

function showStatus() {
  const current = getCurrentSession();
  if (current) {
    const duration = Math.round((Date.now() - current.startTime) / 1000);
    console.log(`🔴 Recording: ${current.name}`);
    console.log(`⏱️  Duration: ${duration}s`);
    console.log(`📁 Project: ${current.projectPath}`);
  } else {
    console.log('⚪ No recording in progress');
  }
}

function listSessions() {
  const sessions = fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.json') || f.endsWith('.ctm'))
    .map(f => {
      const filePath = path.join(SESSIONS_DIR, f);
      const stats = fs.statSync(filePath);
      return {
        name: f,
        size: Math.round(stats.size / 1024),
        date: stats.mtime.toLocaleDateString()
      };
    });

  if (sessions.length === 0) {
    console.log('No sessions found');
    return;
  }

  console.log('📚 Recorded sessions:');
  sessions.forEach(s => {
    console.log(`  ${s.name} (${s.size}KB, ${s.date})`);
  });
}

// Parse command line arguments
function parseArgs(argv) {
  const args = {};
  let currentFlag = null;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    
    if (arg.startsWith('-')) {
      currentFlag = arg.replace(/^-+/, '');
      args[currentFlag] = true;
    } else if (currentFlag) {
      args[currentFlag] = arg;
      currentFlag = null;
    } else if (!args.command) {
      args.command = arg;
    } else if (!args.target) {
      args.target = arg;
    }
  }

  return args;
}

// Main CLI logic
async function main() {
  const args = parseArgs(process.argv);
  
  // Handle daemon mode (internal)
  if (args.command === '_daemon') {
    const sessionFile = process.argv[3];
    const projectPath = process.argv[4];
    const daemon = new FileDaemon(sessionFile, projectPath);
    daemon.start();
    return;
  }

  // Handle user commands
  switch (args.command) {
    case 'start':
      await startRecording(args);
      break;
    case 'stop':
      await stopRecording(args);
      break;
    case 'play':
      if (!args.target) {
        console.log('❌ Session file required');
        return;
      }
      await playSession(args.target);
      break;
    case 'status':
      showStatus();
      break;
    case 'list':
      listSessions();
      break;
    case 'help':
    default:
      showHelp();
      break;
  }
}

if (require.main === module) {
  main().catch(console.error);
}