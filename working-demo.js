#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Real working demo - no external dependencies
console.log('🎬 CodeTimeMachine - ACTUAL Working Demo\n');

// 1. Create a simple in-memory event store
class SimpleEventStore {
  constructor() {
    this.events = [];
    this.sessions = [];
    this.currentSession = null;
  }

  startSession(projectPath) {
    this.currentSession = {
      id: `session_${Date.now()}`,
      projectPath,
      startTime: Date.now(),
      events: []
    };
    this.sessions.push(this.currentSession);
    console.log(`🔴 Started recording: ${this.currentSession.id}`);
    console.log(`📁 Project: ${projectPath}`);
    return this.currentSession.id;
  }

  addEvent(type, source, data) {
    if (!this.currentSession) {
      console.log('❌ No active session');
      return;
    }
    
    const event = {
      timestamp: Date.now(),
      type,
      source,
      data
    };
    
    this.currentSession.events.push(event);
    console.log(`📝 ${type}: ${source} - ${JSON.stringify(data)}`);
  }

  stopSession() {
    if (!this.currentSession) {
      console.log('❌ No active session');
      return;
    }
    
    this.currentSession.endTime = Date.now();
    const duration = (this.currentSession.endTime - this.currentSession.startTime) / 1000;
    console.log(`🛑 Stopped recording: ${duration.toFixed(1)}s`);
    console.log(`📊 Total events: ${this.currentSession.events.length}`);
    
    const sessionData = { ...this.currentSession };
    this.currentSession = null;
    return sessionData;
  }

  getSession(sessionId) {
    return this.sessions.find(s => s.id === sessionId);
  }
}

// 2. Simple file watcher simulation
class FileWatcher {
  constructor(eventStore) {
    this.eventStore = eventStore;
    this.watchedFiles = new Map();
  }

  watchFile(filePath) {
    if (this.watchedFiles.has(filePath)) return;
    
    console.log(`👀 Watching: ${filePath}`);
    
    // Simulate file changes every 2 seconds
    const interval = setInterval(() => {
      this.eventStore.addEvent('file_change', filePath, {
        lines: Math.floor(Math.random() * 100) + 1,
        size: Math.floor(Math.random() * 5000) + 100
      });
    }, 2000);
    
    this.watchedFiles.set(filePath, interval);
  }

  stopWatching() {
    this.watchedFiles.forEach(interval => clearInterval(interval));
    this.watchedFiles.clear();
    console.log('👁️ Stopped watching files');
  }
}

// 3. Simple command simulator
class CommandSimulator {
  constructor(eventStore) {
    this.eventStore = eventStore;
  }

  runCommand(command) {
    this.eventStore.addEvent('terminal', 'bash', {
      command,
      output: `Output from: ${command}`,
      exitCode: 0
    });
  }
}

// 4. Working CLI demo
async function runWorkingDemo() {
  const eventStore = new SimpleEventStore();
  const fileWatcher = new FileWatcher(eventStore);
  const cmdSim = new CommandSimulator(eventStore);

  // Start session
  const sessionId = eventStore.startSession(process.cwd());
  
  // Watch some files
  fileWatcher.watchFile('src/app.js');
  fileWatcher.watchFile('src/utils.js');
  fileWatcher.watchFile('package.json');

  // Simulate development workflow
  console.log('\n🚀 Simulating development workflow...\n');
  
  await sleep(1000);
  cmdSim.runCommand('npm install lodash');
  
  await sleep(2000);
  eventStore.addEvent('file_create', 'src/new-feature.js', { size: 0 });
  
  await sleep(3000);
  cmdSim.runCommand('npm test');
  
  await sleep(2000);
  eventStore.addEvent('git', 'add', { files: ['src/new-feature.js'] });
  
  await sleep(2000);
  cmdSim.runCommand('git commit -m "Add new feature"');

  // Stop after 15 seconds total
  setTimeout(() => {
    fileWatcher.stopWatching();
    const session = eventStore.stopSession();
    
    console.log('\n📊 Session Summary:');
    console.log(`   Duration: ${((session.endTime - session.startTime) / 1000).toFixed(1)}s`);
    console.log(`   Events: ${session.events.length}`);
    console.log(`   Files watched: 3`);
    
    // Show event timeline
    console.log('\n⏰ Event Timeline:');
    session.events.forEach((event, i) => {
      const time = new Date(event.timestamp).toLocaleTimeString();
      console.log(`   ${i + 1}. [${time}] ${event.type}: ${event.source}`);
    });

    console.log('\n✅ Demo complete! This shows the core concept working.');
    console.log('\n📝 What you just saw:');
    console.log('   • Session started and tracked');
    console.log('   • Files monitored for changes');
    console.log('   • Commands logged with output');
    console.log('   • Events timestamped and stored');
    console.log('   • Session properly closed');
    
    console.log('\n🔧 To make it production-ready:');
    console.log('   1. npm install (resolve dependencies)');
    console.log('   2. Build VS Code extension');
    console.log('   3. Create real web viewer');
    console.log('   4. Add SQLite persistence');
    console.log('   5. Hook into real file system events');

    process.exit(0);
  }, 15000);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run the demo
runWorkingDemo().catch(console.error);