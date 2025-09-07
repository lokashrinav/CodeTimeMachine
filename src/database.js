const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class DatabaseWrapper {
  constructor(sessionPath) {
    this.sessionPath = sessionPath;
    this.db = null;
  }

  async init() {
    // Ensure directory exists
    const dir = path.dirname(this.sessionPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.sessionPath);
    await this.createTables();
  }

  async createTables() {
    const schemas = [
      // Sessions table - metadata about recording sessions
      `CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        project_path TEXT NOT NULL,
        git_branch TEXT,
        git_commit TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )`,

      // Events table - all captured events
      `CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL, -- 'file_edit', 'terminal', 'browser', 'git'
        source TEXT, -- file path, terminal session, browser tab
        data TEXT, -- JSON blob with event-specific data
        sequence INTEGER, -- order within same timestamp
        FOREIGN KEY (session_id) REFERENCES sessions (id)
      )`,

      // File snapshots table - file states at specific points
      `CREATE TABLE IF NOT EXISTS file_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER,
        file_path TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        content TEXT,
        content_hash TEXT,
        size INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions (id)
      )`,

      // Diffs table - file changes between snapshots
      `CREATE TABLE IF NOT EXISTS diffs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER,
        file_path TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        diff_data TEXT, -- unified diff format
        line_start INTEGER,
        line_end INTEGER,
        chars_added INTEGER,
        chars_removed INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions (id)
      )`,

      // Terminal sessions table
      `CREATE TABLE IF NOT EXISTS terminal_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER,
        terminal_id TEXT NOT NULL,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        cwd TEXT,
        shell TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions (id)
      )`,

      // Bookmarks table - user-defined interesting moments
      `CREATE TABLE IF NOT EXISTS bookmarks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER,
        timestamp INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        type TEXT DEFAULT 'manual', -- 'manual', 'auto_error', 'auto_test', etc.
        FOREIGN KEY (session_id) REFERENCES sessions (id)
      )`
    ];

    for (const schema of schemas) {
      this.db.exec(schema);
    }

    // Create indexes for performance
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_events_session_timestamp ON events (session_id, timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_events_type ON events (type)',
      'CREATE INDEX IF NOT EXISTS idx_file_snapshots_path_time ON file_snapshots (file_path, timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_diffs_path_time ON diffs (file_path, timestamp)',
      'CREATE INDEX IF NOT EXISTS idx_bookmarks_session_time ON bookmarks (session_id, timestamp)'
    ];

    for (const index of indexes) {
      this.db.exec(index);
    }
  }

  run(sql, params = []) {
    const stmt = this.db.prepare(sql);
    const result = stmt.run(...params);
    return { id: result.lastInsertRowid, changes: result.changes };
  }

  get(sql, params = []) {
    const stmt = this.db.prepare(sql);
    return stmt.get(...params);
  }

  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    return stmt.all(...params);
  }

  async close() {
    if (this.db) {
      this.db.close();
    }
  }

  // High-level methods for common operations
  async createSession(projectPath, gitBranch, gitCommit) {
    const startTime = Date.now();
    const result = this.run(
      'INSERT INTO sessions (start_time, project_path, git_branch, git_commit) VALUES (?, ?, ?, ?)',
      [startTime, projectPath, gitBranch, gitCommit]
    );
    return result.id;
  }

  async endSession(sessionId) {
    const endTime = Date.now();
    this.run(
      'UPDATE sessions SET end_time = ? WHERE id = ?',
      [endTime, sessionId]
    );
  }

  async addEvent(sessionId, type, source, data, sequence = 0) {
    const timestamp = Date.now();
    return this.run(
      'INSERT INTO events (session_id, timestamp, type, source, data, sequence) VALUES (?, ?, ?, ?, ?, ?)',
      [sessionId, timestamp, type, source, JSON.stringify(data), sequence]
    );
  }

  async addFileSnapshot(sessionId, filePath, content) {
    const timestamp = Date.now();
    
    // Ensure content is a proper string and handle encoding
    const cleanContent = typeof content === 'string' ? content : String(content);
    const contentHash = require('crypto').createHash('sha256').update(cleanContent, 'utf8').digest('hex');
    
    return this.run(
      'INSERT INTO file_snapshots (session_id, file_path, timestamp, content, content_hash, size) VALUES (?, ?, ?, ?, ?, ?)',
      [sessionId, filePath, timestamp, cleanContent, contentHash, Buffer.byteLength(cleanContent, 'utf8')]
    );
  }

  async addDiff(sessionId, filePath, diffData, lineStart, lineEnd, charsAdded, charsRemoved) {
    const timestamp = Date.now();
    
    return this.run(
      'INSERT INTO diffs (session_id, file_path, timestamp, diff_data, line_start, line_end, chars_added, chars_removed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [sessionId, filePath, timestamp, diffData, lineStart, lineEnd, charsAdded, charsRemoved]
    );
  }

  async getEventsInRange(sessionId, startTime, endTime) {
    return this.all(
      'SELECT * FROM events WHERE session_id = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp, sequence',
      [sessionId, startTime, endTime]
    );
  }

  async getFileStateAtTime(sessionId, filePath, timestamp) {
    // Get the most recent snapshot before or at the timestamp
    const snapshot = this.get(
      'SELECT * FROM file_snapshots WHERE session_id = ? AND file_path = ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT 1',
      [sessionId, filePath, timestamp]
    );

    if (!snapshot) return null;

    // Get all diffs applied after the snapshot up to the target timestamp
    const diffs = this.all(
      'SELECT * FROM diffs WHERE session_id = ? AND file_path = ? AND timestamp > ? AND timestamp <= ? ORDER BY timestamp',
      [sessionId, filePath, snapshot.timestamp, timestamp]
    );

    return {
      snapshot,
      diffs,
      reconstructedContent: this.applyDiffs(snapshot.content, diffs)
    };
  }

  applyDiffs(content, diffs) {
    // TODO: Implement diff application logic
    // For now, return the base content
    return content;
  }
}

module.exports = DatabaseWrapper;