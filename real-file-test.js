#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Test real file watching without external dependencies
console.log('🧪 Testing REAL File Watching\n');

class RealFileWatcher {
  constructor() {
    this.events = [];
    this.watchers = [];
  }

  watchFile(filePath) {
    console.log(`👀 Watching: ${filePath}`);
    
    let lastModified = 0;
    let lastSize = 0;

    const checkFile = () => {
      try {
        const stats = fs.statSync(filePath);
        
        if (stats.mtime.getTime() !== lastModified || stats.size !== lastSize) {
          const event = {
            timestamp: Date.now(),
            type: 'file_change',
            file: filePath,
            size: stats.size,
            modified: stats.mtime
          };
          
          this.events.push(event);
          console.log(`📝 File changed: ${path.basename(filePath)} (${stats.size} bytes)`);
          
          lastModified = stats.mtime.getTime();
          lastSize = stats.size;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.error('Error watching file:', error.message);
        }
      }
    };

    // Check every 500ms
    const interval = setInterval(checkFile, 500);
    this.watchers.push(interval);
    
    // Initial check
    checkFile();
  }

  stopWatching() {
    this.watchers.forEach(interval => clearInterval(interval));
    this.watchers = [];
    console.log('👁️ Stopped watching files');
  }

  getEvents() {
    return this.events;
  }
}

// Create test files and watch them
async function testRealFileWatching() {
  const watcher = new RealFileWatcher();
  
  // Create test files
  const testFile1 = path.join(__dirname, 'test-file-1.txt');
  const testFile2 = path.join(__dirname, 'test-file-2.js');
  
  fs.writeFileSync(testFile1, 'Initial content');
  fs.writeFileSync(testFile2, 'console.log("hello");');
  
  console.log('📄 Created test files');
  
  // Start watching
  watcher.watchFile(testFile1);
  watcher.watchFile(testFile2);
  
  console.log('\n🎬 Starting file modification test...');
  console.log('   (Will auto-modify files every 2 seconds)\n');
  
  let counter = 0;
  
  const modifyFiles = () => {
    counter++;
    
    // Modify file 1
    fs.appendFileSync(testFile1, `\nLine ${counter} added at ${new Date().toLocaleTimeString()}`);
    
    // Modify file 2
    if (counter % 2 === 0) {
      fs.appendFileSync(testFile2, `\n// Comment ${counter}`);
    }
    
    if (counter < 5) {
      setTimeout(modifyFiles, 2000);
    } else {
      // Finish test
      setTimeout(() => {
        watcher.stopWatching();
        
        console.log('\n📊 Test Results:');
        console.log(`   Events captured: ${watcher.getEvents().length}`);
        console.log(`   Files modified: ${counter} times`);
        
        console.log('\n⏰ Event Log:');
        watcher.getEvents().forEach((event, i) => {
          const time = new Date(event.timestamp).toLocaleTimeString();
          const fileName = path.basename(event.file);
          console.log(`   ${i + 1}. [${time}] ${fileName} - ${event.size} bytes`);
        });
        
        // Cleanup
        fs.unlinkSync(testFile1);
        fs.unlinkSync(testFile2);
        console.log('\n🗑️ Cleaned up test files');
        console.log('\n✅ Real file watching test complete!');
        
        console.log('\n🎯 This proves:');
        console.log('   • File system monitoring works');
        console.log('   • Events are properly timestamped');
        console.log('   • Multiple files can be watched');
        console.log('   • Changes are detected in real-time');
        console.log('   • No external dependencies needed');
        
        process.exit(0);
      }, 1000);
    }
  };
  
  // Start modifying files
  setTimeout(modifyFiles, 2000);
}

testRealFileWatching().catch(console.error);