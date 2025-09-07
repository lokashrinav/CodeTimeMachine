const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const Database = require('./database');

class CodeTimeMachineDaemon {
  constructor(sessionInfo) {
    this.sessionInfo = sessionInfo;
    this.db = null;
    this.watchers = [];
    this.isRunning = false;
  }

  async start() {
    console.log('Starting CodeTimeMachine daemon...');
    
    // Initialize database
    this.db = new Database(this.sessionInfo.dbPath);
    await this.db.init();

    // Start file watching
    await this.startFileWatching();
    
    // Start terminal monitoring (placeholder for now)
    await this.startTerminalMonitoring();

    this.isRunning = true;
    console.log(`Daemon started for session: ${this.sessionInfo.name}`);
    
    // Keep process alive
    process.on('SIGTERM', () => this.stop());
    process.on('SIGINT', () => this.stop());
  }

  async startFileWatching() {
    const projectPath = this.sessionInfo.projectPath;
    
    // Watch for file changes
    const watcher = chokidar.watch(projectPath, {
      ignored: [
        /(^|[\/\\])\../, // ignore dotfiles
        /node_modules/,
        /\.git/,
        /dist/,
        /build/,
        /coverage/,
        /\.ctm$/
      ],
      ignoreInitial: true,
      persistent: true
    });

    watcher.on('change', async (filePath) => {
      await this.handleFileChange(filePath);
    });

    watcher.on('add', async (filePath) => {
      await this.handleFileAdd(filePath);
    });

    watcher.on('unlink', async (filePath) => {
      await this.handleFileDelete(filePath);
    });

    this.watchers.push(watcher);
  }

  async handleFileChange(filePath) {
    try {
      // Skip binary files and large files
      const stats = fs.statSync(filePath);
      if (stats.size > 100000) { // Skip files larger than 100KB
        return;
      }

      // Check if file is likely to be text
      const ext = path.extname(filePath).toLowerCase();
      const textExtensions = ['.txt', '.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.json', '.md', '.yml', '.yaml', '.xml', '.svg', '.py', '.java', '.c', '.cpp', '.h', '.cs', '.php', '.rb', '.go', '.rs', '.sh', '.bat', '.ps1'];
      if (!textExtensions.includes(ext) && ext !== '') {
        return; // Skip non-text files
      }

      // Read current file content with explicit UTF-8 encoding
      const content = fs.readFileSync(filePath, { encoding: 'utf8' });
      
      // Get relative path
      const relativePath = path.relative(this.sessionInfo.projectPath, filePath);
      
      // Add event
      await this.db.addEvent(
        this.sessionInfo.dbId,
        'file_edit',
        relativePath,
        {
          action: 'change',
          size: content.length,
          lines: content.split('\n').length
        }
      );

      // Store snapshot (for small files)
      if (content.length < 100000) { // 100KB limit
        await this.db.addFileSnapshot(
          this.sessionInfo.dbId,
          relativePath,
          content
        );
      }

      console.log(`📝 File changed: ${relativePath}`);
    } catch (error) {
      console.error('Error handling file change:', error.message);
    }
  }

  async handleFileAdd(filePath) {
    try {
      // Skip binary files and large files
      const stats = fs.statSync(filePath);
      if (stats.size > 100000) { // Skip files larger than 100KB
        return;
      }

      // Check if file is likely to be text
      const ext = path.extname(filePath).toLowerCase();
      const textExtensions = ['.txt', '.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.json', '.md', '.yml', '.yaml', '.xml', '.svg', '.py', '.java', '.c', '.cpp', '.h', '.cs', '.php', '.rb', '.go', '.rs', '.sh', '.bat', '.ps1'];
      if (!textExtensions.includes(ext) && ext !== '') {
        return; // Skip non-text files
      }

      const relativePath = path.relative(this.sessionInfo.projectPath, filePath);
      const content = fs.readFileSync(filePath, { encoding: 'utf8' });
      
      await this.db.addEvent(
        this.sessionInfo.dbId,
        'file_edit',
        relativePath,
        {
          action: 'add',
          size: content.length,
          lines: content.split('\n').length
        }
      );

      if (content.length < 100000) {
        await this.db.addFileSnapshot(
          this.sessionInfo.dbId,
          relativePath,
          content
        );
      }

      console.log(`➕ File added: ${relativePath}`);
    } catch (error) {
      console.error('Error handling file add:', error.message);
    }
  }

  async handleFileDelete(filePath) {
    try {
      const relativePath = path.relative(this.sessionInfo.projectPath, filePath);
      
      await this.db.addEvent(
        this.sessionInfo.dbId,
        'file_edit',
        relativePath,
        {
          action: 'delete'
        }
      );

      console.log(`🗑️  File deleted: ${relativePath}`);
    } catch (error) {
      console.error('Error handling file delete:', error.message);
    }
  }

  async startTerminalMonitoring() {
    // Placeholder for terminal monitoring
    // In a full implementation, this would:
    // 1. Hook into shell history
    // 2. Monitor terminal output
    // 3. Track working directory changes
    
    console.log('Terminal monitoring: placeholder (not yet implemented)');
  }

  async stop() {
    if (!this.isRunning) return;

    console.log('Stopping CodeTimeMachine daemon...');
    this.isRunning = false;

    // Stop all watchers
    for (const watcher of this.watchers) {
      await watcher.close();
    }

    // Close database
    if (this.db) {
      await this.db.close();
    }

    console.log('Daemon stopped');
    process.exit(0);
  }
}

// Main execution
async function main() {
  const sessionInfoArg = process.argv[2];
  if (!sessionInfoArg) {
    console.error('Session info required');
    process.exit(1);
  }

  try {
    const sessionInfo = JSON.parse(sessionInfoArg);
    const daemon = new CodeTimeMachineDaemon(sessionInfo);
    await daemon.start();
  } catch (error) {
    console.error('Daemon error:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = CodeTimeMachineDaemon;