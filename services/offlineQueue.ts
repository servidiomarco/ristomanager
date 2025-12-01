// Offline Queue Service
// Queues API operations while offline and flushes them when reconnected

type QueuedOperation = {
  id: string;
  operation: () => Promise<any>;
  description: string;
  timestamp: Date;
};

class OfflineQueue {
  private queue: QueuedOperation[] = [];
  private isProcessing = false;
  private storageKey = 'offline_queue';

  constructor() {
    // Load queue from localStorage on initialization
    this.loadFromStorage();
  }

  // Add an operation to the queue
  enqueue(operation: () => Promise<any>, description: string) {
    const queuedOp: QueuedOperation = {
      id: Math.random().toString(36).substring(2, 11),
      operation,
      description,
      timestamp: new Date()
    };

    this.queue.push(queuedOp);
    this.saveToStorage();

    console.log(`📥 Queued operation: ${description}`);
    return queuedOp.id;
  }

  // Get the current queue size
  size() {
    return this.queue.length;
  }

  // Check if queue is empty
  isEmpty() {
    return this.queue.length === 0;
  }

  // Flush all queued operations
  async flush(): Promise<{ success: number; failed: number }> {
    if (this.isProcessing || this.isEmpty()) {
      return { success: 0, failed: 0 };
    }

    this.isProcessing = true;
    console.log(`🔄 Flushing offline queue (${this.queue.length} operations)`);

    let successCount = 0;
    let failedCount = 0;

    // Process queue in order (FIFO)
    while (this.queue.length > 0) {
      const op = this.queue[0]; // Peek at first operation

      try {
        console.log(`⏳ Processing: ${op.description}`);
        await op.operation();

        // Remove from queue on success
        this.queue.shift();
        successCount++;
        console.log(`✅ Success: ${op.description}`);
      } catch (error) {
        console.error(`❌ Failed: ${op.description}`, error);
        failedCount++;

        // Keep failed operation in queue for retry
        // Move it to the end to try other operations
        const failedOp = this.queue.shift();
        if (failedOp) {
          this.queue.push(failedOp);
        }

        // Stop processing if we've tried all operations once
        if (failedCount >= this.queue.length) {
          break;
        }
      }
    }

    this.isProcessing = false;
    this.saveToStorage();

    console.log(`📊 Flush complete: ${successCount} succeeded, ${failedCount} failed`);
    return { success: successCount, failed: failedCount };
  }

  // Clear all queued operations
  clear() {
    this.queue = [];
    this.saveToStorage();
    console.log('🗑️ Offline queue cleared');
  }

  // Get all queued operations (for display)
  getAll() {
    return this.queue.map(op => ({
      id: op.id,
      description: op.description,
      timestamp: op.timestamp
    }));
  }

  // Save queue to localStorage (without the operation functions)
  private saveToStorage() {
    try {
      const serializable = this.queue.map(op => ({
        id: op.id,
        description: op.description,
        timestamp: op.timestamp.toISOString()
      }));
      localStorage.setItem(this.storageKey, JSON.stringify(serializable));
    } catch (error) {
      console.error('Failed to save offline queue to storage:', error);
    }
  }

  // Load queue from localStorage
  // Note: Operations themselves can't be serialized, so this only restores metadata
  // The actual API calls need to be re-queued when the app restarts
  private loadFromStorage() {
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (stored) {
        const parsed = JSON.parse(stored);
        console.log(`📦 Loaded ${parsed.length} items from storage (metadata only)`);
        // Note: We can't restore the actual operations, only the metadata
        // In a production app, you'd need to serialize operation parameters
        // and reconstruct the operations on load
      }
    } catch (error) {
      console.error('Failed to load offline queue from storage:', error);
    }
  }
}

// Export singleton instance
export const offlineQueue = new OfflineQueue();
