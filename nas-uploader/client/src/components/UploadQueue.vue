<template>
  <div class="upload-queue card">
    <h2>上传队列</h2>
    <div v-if="queue.length === 0" class="empty">暂无任务</div>
    <ul v-else>
      <li v-for="item in queue" :key="item.id" :class="['task', item.status]">
        <div class="task-name" :title="item.filePath">{{ basename(item.filePath) }}</div>
        <div class="task-meta">
          <span class="status-badge">{{ statusLabel(item.status) }}</span>
          <span v-if="item.speed" class="speed">{{ item.speed }}</span>
        </div>
        <div class="progress-bar" v-if="item.status === 'uploading' || item.status === 'done'">
          <div class="progress-fill" :style="{ width: item.progress + '%' }"></div>
        </div>
        <div v-if="item.status === 'error'" class="error-msg">{{ item.error }}</div>
      </li>
    </ul>
  </div>
</template>

<script setup>
defineProps({ queue: { type: Array, default: () => [] } });

function basename(p) { return p ? p.split('/').pop() : ''; }

function statusLabel(s) {
  return { queued: '等待中', uploading: '上传中', done: '完成', error: '失败' }[s] ?? s;
}
</script>

<style scoped>
.card { background: #fff; border-radius: 8px; padding: 16px; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
h2 { font-size: 1rem; font-weight: 600; margin-bottom: 12px; }
.empty { color: #aaa; font-size: .875rem; padding: 20px 0; text-align: center; }
ul { list-style: none; display: flex; flex-direction: column; gap: 10px; max-height: 70vh; overflow-y: auto; }
.task { padding: 10px 12px; border-radius: 6px; background: #fafafa; border: 1px solid #eee; }
.task.done { border-color: #6ee7b7; background: #f0fdf4; }
.task.error { border-color: #fca5a5; background: #fff5f5; }
.task.uploading { border-color: #93c5fd; background: #eff6ff; }
.task-name { font-size: .875rem; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 4px; }
.task-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.status-badge { font-size: .75rem; padding: 1px 8px; border-radius: 10px; background: #e5e7eb; color: #374151; }
.task.done .status-badge { background: #d1fae5; color: #065f46; }
.task.error .status-badge { background: #fee2e2; color: #991b1b; }
.task.uploading .status-badge { background: #dbeafe; color: #1e40af; }
.speed { font-size: .75rem; color: #6b7280; }
.progress-bar { height: 6px; background: #e5e7eb; border-radius: 3px; overflow: hidden; }
.progress-fill { height: 100%; background: #1677ff; border-radius: 3px; transition: width .3s; }
.task.done .progress-fill { background: #10b981; }
.error-msg { font-size: .75rem; color: #dc2626; margin-top: 4px; }
</style>
