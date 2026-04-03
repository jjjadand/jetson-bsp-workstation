<template>
  <div class="app">
    <header>
      <h1>NAS → OneDrive 上传工具</h1>
    </header>
    <main>
      <FileList @upload="handleUpload" />
      <UploadQueue :queue="uploadQueue" />
    </main>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import FileList from './components/FileList.vue';
import UploadQueue from './components/UploadQueue.vue';

const uploadQueue = ref([]);
let sse = null;

function connectSSE() {
  sse = new EventSource('/api/progress');
  sse.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'queue') {
      uploadQueue.value = data.queue;
    } else if (data.type === 'update') {
      const idx = uploadQueue.value.findIndex(i => i.id === data.item.id);
      if (idx >= 0) uploadQueue.value[idx] = data.item;
      else uploadQueue.value.push(data.item);
    }
  };
  sse.onerror = () => {
    sse.close();
    setTimeout(connectSSE, 3000);
  };
}

async function handleUpload(paths) {
  await fetch('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths })
  });
}

onMounted(connectSSE);
onUnmounted(() => sse?.close());
</script>

<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, sans-serif; background: #f5f5f5; color: #333; }
.app { max-width: 1200px; margin: 0 auto; padding: 16px; }
header { margin-bottom: 20px; }
header h1 { font-size: 1.4rem; font-weight: 600; }
main { display: grid; grid-template-columns: 1fr 360px; gap: 16px; }
@media (max-width: 800px) { main { grid-template-columns: 1fr; } }
</style>
