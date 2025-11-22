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
  const consoleMethod = level === 'ERROR' ? console.error :
                        level === 'WARN' ? console.warn :
                        level === 'INFO' ? console.info :
                        console.log;
  
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

