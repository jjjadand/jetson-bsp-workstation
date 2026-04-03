<template>
  <div class="file-list card">
    <div class="toolbar">
      <div class="tabs">
        <button v-for="t in tabs" :key="t.value"
          :class="['tab', { active: activeTab === t.value }]"
          @click="switchTab(t.value)">{{ t.label }}</button>
      </div>
      <button class="btn-upload" :disabled="selected.size === 0" @click="uploadSelected">
        上传选中 ({{ selected.size }})
      </button>
    </div>

    <div v-if="loading" class="state">加载中...</div>
    <div v-else-if="error" class="state error">{{ error }}</div>
    <div v-else-if="files.length === 0" class="state">暂无文件</div>

    <table v-else>
      <thead>
        <tr>
          <th><input type="checkbox" :checked="allSelected" @change="toggleAll" /></th>
          <th>文件名</th>
          <th>大小</th>
          <th>修改时间</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="f in files" :key="f.path" :class="{ uploaded: f.uploaded }">
          <td><input type="checkbox" :checked="selected.has(f.path)" @change="toggle(f.path)" /></td>
          <td class="name" :title="f.path">{{ basename(f.path) }}</td>
          <td class="size">{{ fmtSize(f.size) }}</td>
          <td class="mtime">{{ fmtDate(f.mtime) }}</td>
          <td><span v-if="f.uploaded" class="badge-done">已上传</span></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';

const emit = defineEmits(['upload']);

const tabs = [
  { label: '最近1天', value: '1' },
  { label: '最近7天', value: '7' },
  { label: '最近30天', value: '30' },
  { label: '全部', value: 'all' },
];

const activeTab = ref('7');
const files = ref([]);
const loading = ref(false);
const error = ref('');
const selected = ref(new Set());

const allSelected = computed(() =>
  files.value.length > 0 && files.value.every(f => selected.value.has(f.path))
);

async function fetchFiles(tab) {
  loading.value = true;
  error.value = '';
  try {
    const url = tab === 'all' ? '/api/files/all' : `/api/files?days=${tab}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    files.value = await res.json();
    selected.value = new Set();
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function switchTab(val) {
  activeTab.value = val;
  fetchFiles(val);
}

function toggle(p) {
  const s = new Set(selected.value);
  s.has(p) ? s.delete(p) : s.add(p);
  selected.value = s;
}

function toggleAll() {
  if (allSelected.value) {
    selected.value = new Set();
  } else {
    selected.value = new Set(files.value.map(f => f.path));
  }
}

function uploadSelected() {
  emit('upload', [...selected.value]);
  selected.value = new Set();
}

function basename(p) { return p.split('/').pop(); }

function fmtSize(bytes) {
  if (bytes == null) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function fmtDate(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

onMounted(() => fetchFiles(activeTab.value));
</script>

<style scoped>
.card { background: #fff; border-radius: 8px; padding: 16px; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
.toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; flex-wrap: wrap; gap: 8px; }
.tabs { display: flex; gap: 4px; }
.tab { padding: 5px 14px; border: 1px solid #ddd; border-radius: 4px; background: #fafafa; cursor: pointer; font-size: .875rem; }
.tab.active { background: #1677ff; color: #fff; border-color: #1677ff; }
.btn-upload { padding: 5px 16px; background: #1677ff; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: .875rem; }
.btn-upload:disabled { background: #aaa; cursor: not-allowed; }
.state { padding: 40px; text-align: center; color: #888; }
.state.error { color: #e53e3e; }
table { width: 100%; border-collapse: collapse; font-size: .875rem; }
th { text-align: left; padding: 8px 6px; border-bottom: 2px solid #eee; color: #666; font-weight: 500; }
td { padding: 7px 6px; border-bottom: 1px solid #f0f0f0; }
tr.uploaded td { color: #aaa; }
.name { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.size, .mtime { white-space: nowrap; }
.badge-done { background: #d1fae5; color: #065f46; padding: 2px 8px; border-radius: 10px; font-size: .75rem; }
</style>
