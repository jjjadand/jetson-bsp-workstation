<template>
  <div class="upload-queue card">
    <h2>上传队列</h2>
    <div v-if="queue.length === 0" class="empty">暂无任务</div>
    <ul v-else>
      <li v-for="item in queue" :key="item.id" :class="['task', item.status]">
        <div class="task-name" :title="item.filePath">{{ basename(item.filePath) }}</div>
        <div class="task-meta">
          <span class="status-badge">{{ statusLabel(item.status) }}</span>
          <span v-if="item.status === 'uploading' || item.status === 'done'" class="percent">{{ formatProgress(item.progress) }}</span>
          <span v-if="item.speed" class="speed">{{ item.speed }}</span>
        </div>
        <div class="progress-bar" v-if="item.status === 'uploading' || item.status === 'done'">
          <div class="progress-fill" :style="{ width: item.progress + '%' }"></div>
        </div>
        <div v-if="item.totalBytes" class="transfer-meta">
          {{ formatBytes(item.transferredBytes) }} / {{ formatBytes(item.totalBytes) }}
        </div>
        <div v-if="item.status === 'done' && item.link" class="link-row">
          <a :href="item.link" target="_blank" rel="noopener" class="link">OneDrive 链接</a>
          <button class="btn-copy" @click="copyLink(item.link)">复制</button>
          <span v-if="item.wikiUpdated" class="wiki-badge">已同步Wiki</span>
          <span v-else-if="wikiConfigured === false" class="wiki-badge disabled">Wiki未配置</span>
        </div>
        <div v-if="item.status === 'error'" class="error-msg">{{ item.error }}</div>
      </li>
    </ul>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';

defineProps({ queue: { type: Array, default: () => [] } });

const wikiConfigured = ref(null);

onMounted(async () => {
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const cfg = await res.json();
      wikiConfigured.value = !!(cfg.wiki?.enabled && (cfg.wiki?.url || cfg.wiki?.type === 'local_git'));
    }
  } catch {
    wikiConfigured.value = false;
  }
});

function basename(p) { return p ? p.split('/').pop() : ''; }

function statusLabel(s) {
  return { queued: '等待中', uploading: '上传中', done: '完成', error: '失败' }[s] ?? s;
}

function formatProgress(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0%';
  return `${num.toFixed(num >= 10 || Number.isInteger(num) ? 0 : 1)}%`;
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';

  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

async function copyLink(url) {
  try {
    await navigator.clipboard.writeText(url);
    alert('链接已复制到剪贴板');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    alert('链接已复制到剪贴板');
  }
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
.percent { font-size: .75rem; color: #475467; min-width: 3rem; }
.speed { font-size: .75rem; color: #6b7280; }
.progress-bar { height: 6px; background: #e5e7eb; border-radius: 3px; overflow: hidden; }
.progress-fill { height: 100%; background: #1677ff; border-radius: 3px; transition: width .3s; }
.transfer-meta { margin-top: 6px; font-size: .75rem; color: #667085; }
.task.done .progress-fill { background: #10b981; }
.error-msg { font-size: .75rem; color: #dc2626; margin-top: 4px; }

.link-row { margin-top: 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.link { font-size: .8125rem; color: #1677ff; text-decoration: none; word-break: break-all; }
.link:hover { text-decoration: underline; }
.btn-copy { font-size: .75rem; padding: 2px 8px; border: 1px solid #d0d5dd; border-radius: 4px; background: #fff; cursor: pointer; color: #374151; }
.btn-copy:hover { background: #f9fafb; }
.wiki-badge { font-size: .75rem; padding: 1px 6px; border-radius: 10px; background: #dbeafe; color: #1e40af; }
.wiki-badge.disabled { background: #f3f4f6; color: #9ca3af; }
</style>
