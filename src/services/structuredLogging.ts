import db from '../db';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export type LogSource = 
  | 'rss-sync' 
  | 'radarr-sync' 
  | 'matching-engine' 
  | 'tmdb' 
  | 'imdb' 
  | 'radarr-api' 
  | 'parser' 
  | 'scoring' 
  | 'dashboard' 
  | 'api' 
  | 'system';

export interface StructuredLogEntry {
  id?: number;
  timestamp: Date;
  level: LogLevel;
  source: LogSource;
  message: string;
  details?: any; // JSON object
  filePath?: string;
  releaseTitle?: string;
  jobId?: string;
  errorStack?: string;
}

// Keep in-memory buffer for fast writes (batch insert)
const LOG_BUFFER: StructuredLogEntry[] = [];
const BUFFER_SIZE = 50;
const FLUSH_INTERVAL = 5000; // 5 seconds

let flushTimer: NodeJS.Timeout | null = null;

function flushLogs() {
  if (LOG_BUFFER.length === 0) return;
  
  const logsToInsert = LOG_BUFFER.splice(0, LOG_BUFFER.length);
  
  try {
    const stmt = db.prepare(`
      INSERT INTO structured_logs (
        timestamp, level, source, message, details, file_path, release_title, job_id, error_stack
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const insertMany = db.transaction((logs: StructuredLogEntry[]) => {
      for (const log of logs) {
        stmt.run(
          log.timestamp.toISOString(),
          log.level,
          log.source,
          log.message,
          log.details ? JSON.stringify(log.details) : null,
          log.filePath || null,
          log.releaseTitle || null,
          log.jobId || null,
          log.errorStack || null
        );
      }
    });
    
    insertMany(logsToInsert);
  } catch (error) {
    console.error('Error flushing logs to database:', error);
    // Put logs back in buffer to retry later
    LOG_BUFFER.unshift(...logsToInsert);
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushLogs();
    flushTimer = null;
    if (LOG_BUFFER.length > 0) {
      scheduleFlush();
    }
  }, FLUSH_INTERVAL);
}

export function log(
  level: LogLevel,
  source: LogSource,
  message: string,
  options?: {
    details?: any;
    filePath?: string;
    releaseTitle?: string;
    jobId?: string;
    error?: Error;
  }
) {
  const entry: StructuredLogEntry = {
    timestamp: new Date(),
    level,
    source,
    message,
    details: options?.details,
    filePath: options?.filePath,
    releaseTitle: options?.releaseTitle,
    jobId: options?.jobId,
    errorStack: options?.error?.stack,
  };
  
  // Add to buffer
  LOG_BUFFER.push(entry);
  
  // Flush if buffer is full
  if (LOG_BUFFER.length >= BUFFER_SIZE) {
    flushLogs();
  } else {
    scheduleFlush();
  }
  
  // Also log to console for backward compatibility
  // IMPORTANT: Use original console methods to avoid infinite loop with logStorage
  // Store references to original console methods before they're overridden
  const originalConsoleLog = (console as any).__originalLog || console.log;
  const originalConsoleError = (console as any).__originalError || console.error;
  const originalConsoleWarn = (console as any).__originalWarn || console.warn;
  const originalConsoleInfo = (console as any).__originalInfo || console.info;
  
  const consoleMethod = level === 'ERROR' ? originalConsoleError :
                        level === 'WARN' ? originalConsoleWarn :
                        level === 'INFO' ? originalConsoleInfo :
                        originalConsoleLog;
  
  const prefix = `[${level}] [${source}]`;
  if (options?.error) {
    consoleMethod(prefix, message, options.error);
  } else if (options?.details) {
    consoleMethod(prefix, message, options.details);
  } else {
    consoleMethod(prefix, message);
  }
}

// Helper functions for common log levels
type LogOptions = {
  details?: any;
  filePath?: string;
  releaseTitle?: string;
  jobId?: string;
  error?: Error;
};

export const logger = {
  debug: (source: LogSource, message: string, options?: LogOptions) => {
    log('DEBUG', source, message, options);
  },
  info: (source: LogSource, message: string, options?: LogOptions) => {
    log('INFO', source, message, options);
  },
  warn: (source: LogSource, message: string, options?: LogOptions) => {
    log('WARN', source, message, options);
  },
  error: (source: LogSource, message: string, options?: LogOptions) => {
    log('ERROR', source, message, options);
  },
};

// Flush logs on process exit
process.on('beforeExit', () => {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushLogs();
});

// Export for manual flush if needed
export function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushLogs();
}


// Automatic log cleanup - runs daily
// Keep last 7 days of logs, but always keep ERROR and WARN logs
const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
const LOG_RETENTION_DAYS = 7;

function cleanupOldLogs() {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - LOG_RETENTION_DAYS);
    const cutoffDateStr = cutoffDate.toISOString();
    
    // Delete old DEBUG and INFO logs, but keep ERROR and WARN
    const result = db.prepare(`
      DELETE FROM structured_logs 
      WHERE timestamp < ? 
      AND level IN ('DEBUG', 'INFO')
    `).run(cutoffDateStr);
    
    if (result.changes > 0) {
      console.log(`[LOG CLEANUP] Deleted ${result.changes} old log entries (older than ${LOG_RETENTION_DAYS} days)`);
      
      // Vacuum database every 10th cleanup to reclaim space
      const cleanupCount = db.prepare("SELECT value FROM app_settings WHERE key = 'log_cleanup_count'").get() as any;
      const count = (cleanupCount?.value ? parseInt(cleanupCount.value, 10) : 0) + 1;
      db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('log_cleanup_count', ?)").run(String(count));
      
      if (count % 10 === 0) {
        console.log('[LOG CLEANUP] Running VACUUM to reclaim database space...');
        db.exec('VACUUM');
      }
    }
  } catch (error) {
    console.error('[LOG CLEANUP] Error cleaning up logs:', error);
  }
}

// Schedule automatic cleanup
setInterval(cleanupOldLogs, CLEANUP_INTERVAL);
// Run cleanup on startup (after a delay to let app initialize)
setTimeout(cleanupOldLogs, 60000); // Run after 1 minute
