#!/usr/bin/env node

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const Database = require('./database');

const program = new Command();

// Global configuration
const CONFIG_DIR = path.join(os.homedir(), '.codetimemachine');
const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions');
const PID_FILE = path.join(CONFIG_DIR, 'daemon.pid');
const CURRENT_SESSION_FILE = path.join(CONFIG_DIR, 'current_session.json');

// Ensure config directories exist
if (!fs.existsSync(CONFIG_DIR)) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

program
  .name('ctm')
  .description('CodeTimeMachine - A flight recorder for developers')
  .version('0.1.0');

program
  .command('start')
  .description('Start recording a coding session')
  .option('-p, --project <path>', 'Project directory to monitor', process.cwd())
  .option('-n, --name <name>', 'Session name')
  .action(async (options) => {
    try {
      await startRecording(options);
    } catch (error) {
      console.error('Error starting recording:', error.message);
      process.exit(1);
    }
  });

program
  .command('stop')
  .description('Stop recording and optionally save session')
  .option('-o, --output <file>', 'Output file path (creates .ctm file)')
  .option('-k, --keep', 'Keep temporary session data after export')
  .action(async (options) => {
    try {
      await stopRecording(options);
    } catch (error) {
      console.error('Error stopping recording:', error.message);
      process.exit(1);
    }
  });

program
  .command('play <sessionFile>')
  .description('Play back a recorded session')
  .option('-p, --port <port>', 'Web server port', '3000')
  .option('-o, --open', 'Open browser automatically', true)
  .action(async (sessionFile, options) => {
    try {
      await playSession(sessionFile, options);
    } catch (error) {
      console.error('Error playing session:', error.message);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show current recording status')
  .action(async () => {
    try {
      await showStatus();
    } catch (error) {
      console.error('Error getting status:', error.message);
      process.exit(1);
    }
  });

program
  .command('list')
  .description('List recorded sessions')
  .action(async () => {
    try {
      await listSessions();
    } catch (error) {
      console.error('Error listing sessions:', error.message);
      process.exit(1);
    }
  });

async function startRecording(options) {
  // Check if already recording
  if (isRecording()) {
    console.log('⚠️  Recording already in progress. Use "ctm stop" first.');
    return;
  }

  const projectPath = path.resolve(options.project);
  const sessionName = options.name || `session_${Date.now()}`;
  const sessionId = `${sessionName}_${Date.now()}`;
  const dbPath = path.join(SESSIONS_DIR, `${sessionId}.db`);

  // Initialize database
  const db = new Database(dbPath);
  await db.init();

  // Get git info if available
  let gitBranch = null;
  let gitCommit = null;
  try {
    const git = require('simple-git')(projectPath);
    const status = await git.status();
    gitBranch = status.current;
    const log = await git.log(['--oneline', '-1']);
    gitCommit = log.latest?.hash;
  } catch (error) {
    // Git info optional
  }

  // Create session
  const sessionDbId = await db.createSession(projectPath, gitBranch, gitCommit);
  await db.close();

  // Save current session info
  const sessionInfo = {
    id: sessionId,
    dbId: sessionDbId,
    dbPath,
    projectPath,
    startTime: Date.now(),
    name: sessionName
  };

  fs.writeFileSync(CURRENT_SESSION_FILE, JSON.stringify(sessionInfo, null, 2));

  // Start daemon
  await startDaemon(sessionInfo);

  console.log(`🎬 Recording started: ${sessionName}`);
  console.log(`📁 Project: ${projectPath}`);
  console.log(`💾 Session DB: ${dbPath}`);
  if (gitBranch) console.log(`🌿 Git branch: ${gitBranch}`);
  if (gitCommit) console.log(`📝 Git commit: ${gitCommit.substring(0, 8)}`);
  console.log('');
  console.log('Use "ctm stop" to finish recording');
}

async function stopRecording(options) {
  if (!isRecording()) {
    console.log('⚠️  No recording in progress.');
    return;
  }

  const sessionInfo = getCurrentSession();
  
  // Stop daemon
  await stopDaemon();

  // Finalize database
  const db = new Database(sessionInfo.dbPath);
  await db.init();
  await db.endSession(sessionInfo.dbId);
  await db.close();

  const endTime = Date.now();
  const duration = Math.round((endTime - sessionInfo.startTime) / 1000);

  console.log(`🛑 Recording stopped: ${sessionInfo.name}`);
  console.log(`⏱️  Duration: ${duration}s`);

  // Export session if output specified
  if (options.output) {
    await exportSession(sessionInfo, options.output);
    console.log(`💾 Session exported: ${options.output}`);
  }

  // Clean up
  if (!options.keep && !options.output) {
    fs.unlinkSync(sessionInfo.dbPath);
    console.log('🗑️  Temporary session data removed');
  }

  fs.unlinkSync(CURRENT_SESSION_FILE);
}

async function playSession(sessionFile, options) {
  const sessionPath = path.resolve(sessionFile);
  
  if (!fs.existsSync(sessionPath)) {
    throw new Error(`Session file not found: ${sessionPath}`);
  }

  console.log(`🎥 Starting playback server...`);
  console.log(`📁 Session: ${sessionPath}`);
  console.log(`🌐 Server: http://localhost:${options.port}`);

  // Start web server
  const server = require('./server');
  await server.start(sessionPath, options.port);

  if (options.open) {
    const { spawn } = require('child_process');
    const url = `http://localhost:${options.port}`;
    
    // Cross-platform open command
    const cmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(cmd, [url], { shell: true, detached: true });
  }

  console.log('Press Ctrl+C to stop server');
}

async function showStatus() {
  if (isRecording()) {
    const sessionInfo = getCurrentSession();
    const duration = Math.round((Date.now() - sessionInfo.startTime) / 1000);
    console.log(`🔴 Recording in progress: ${sessionInfo.name}`);
    console.log(`⏱️  Duration: ${duration}s`);
    console.log(`📁 Project: ${sessionInfo.projectPath}`);
  } else {
    console.log('⚪ No recording in progress');
  }
}

async function listSessions() {
  const files = fs.readdirSync(SESSIONS_DIR);
  const sessions = files.filter(f => f.endsWith('.db') || f.endsWith('.ctm'));
  
  if (sessions.length === 0) {
    console.log('No sessions found');
    return;
  }

  console.log('📚 Recorded sessions:');
  for (const file of sessions) {
    const filePath = path.join(SESSIONS_DIR, file);
    const stats = fs.statSync(filePath);
    const size = Math.round(stats.size / 1024);
    console.log(`  ${file} (${size}KB, ${stats.mtime.toLocaleDateString()})`);
  }
}

function isRecording() {
  return fs.existsSync(CURRENT_SESSION_FILE);
}

function getCurrentSession() {
  if (!fs.existsSync(CURRENT_SESSION_FILE)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(CURRENT_SESSION_FILE, 'utf8'));
}

async function startDaemon(sessionInfo) {
  const daemonPath = path.join(__dirname, 'daemon.js');
  const daemon = spawn('node', [daemonPath, JSON.stringify(sessionInfo)], {
    detached: true,
    stdio: 'ignore'
  });
  
  daemon.unref();
  
  // Save daemon PID
  fs.writeFileSync(PID_FILE, daemon.pid.toString());
  
  // Give daemon time to start
  await new Promise(resolve => setTimeout(resolve, 1000));
}

async function stopDaemon() {
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8'));
    
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      // Process might already be dead
    }
    
    fs.unlinkSync(PID_FILE);
  }
}

async function exportSession(sessionInfo, outputPath) {
  // For now, just copy the database file
  const outputFile = outputPath.endsWith('.ctm') ? outputPath : `${outputPath}.ctm`;
  fs.copyFileSync(sessionInfo.dbPath, outputFile);
}

program.parse();

module.exports = { program };