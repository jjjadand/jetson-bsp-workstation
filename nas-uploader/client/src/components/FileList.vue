<template>
  <div class="file-list card">
    <div class="toolbar">
      <div class="tabs">
        <button v-for="t in tabs" :key="t.value"
          :class="['tab', { active: activeTab === t.value }]"
          @click="switchTab(t.value)">{{ t.label }}</button>
      </div>
      <div class="upload-actions">
        <label class="sync-check">
          <input type="checkbox" v-model="syncWiki" />
          同步到Wiki
        </label>
        <button class="btn-upload" :disabled="selected.size === 0" @click="uploadSelected">
          上传选中 ({{ selected.size }})
        </button>
        <button
          class="btn-secondary"
          :disabled="selectedWikiActionableCount === 0 || batchSyncing"
          @click="syncSelectedToWiki"
        >
          {{ batchSyncing ? `同步中 (${batchSyncProgress}/${selectedWikiActionableCount})` : `批量同步Wiki (${selectedWikiActionableCount})` }}
        </button>
      </div>
    </div>

    <div class="search-bar">
      <input
        v-model.trim="searchInput"
        class="search-input"
        type="text"
        placeholder="搜索文件名或路径"
        @keyup.enter="applySearch"
      />
      <button class="btn-search" @click="applySearch">搜索</button>
      <button class="btn-secondary" :disabled="!searchInput && !searchKeyword" @click="clearSearch">清空</button>
    </div>

    <div class="list-meta">
      <span>共 {{ files.length }} 个文件</span>
      <span v-if="searchKeyword">关键词：{{ searchKeyword }}</span>
    </div>

    <div v-if="loading" class="state">加载中...</div>
    <div v-else-if="error" class="state error">{{ error }}</div>
    <div v-else-if="files.length === 0" class="state">{{ emptyStateText }}</div>

    <table v-else>
      <thead>
        <tr>
          <th><input type="checkbox" :checked="allSelected" @change="toggleAll" /></th>
          <th>文件名</th>
          <th>大小</th>
          <th>修改时间</th>
          <th>状态</th>
          <th>链接</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="f in files" :key="f.path" :class="{ uploaded: f.uploaded }">
          <td><input type="checkbox" :checked="selected.has(f.path)" @change="toggle(f.path)" /></td>
          <td class="name" :title="f.path">{{ basename(f.path) }}</td>
          <td class="size">{{ fmtSize(f.size) }}</td>
          <td class="mtime">{{ fmtDate(f.mtime) }}</td>
          <td><span v-if="f.uploaded" class="badge-done">已上传</span></td>
          <td class="link-cell">
            <a v-if="f.link" :href="f.link" target="_blank" rel="noopener" class="link" title="打开OneDrive链接">打开</a>
            <button v-if="f.link" class="btn-copy-sm" @click="copyLink(f.link)" title="复制链接">复制</button>
            <button
              v-if="canSyncToWiki(f)"
              class="btn-sync-sm"
              :disabled="syncingPaths.has(f.path)"
              @click="syncToWiki(f.path)"
              title="同步到Wiki"
            >
              {{ syncingPaths.has(f.path) ? '同步中' : f.wikiUpdated ? '重新同步' : '同步Wiki' }}
            </button>
            <span v-if="f.wikiUpdated" class="wiki-synced">已同步</span>
          </td>
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
const searchInput = ref('');
const searchKeyword = ref('');
const syncWiki = ref(true);
const batchSyncing = ref(false);
const batchSyncProgress = ref(0);
const syncingPaths = ref(new Set());

const allSelected = computed(() =>
  files.value.length > 0 && files.value.every(f => selected.value.has(f.path))
);

const selectedWikiActionableFiles = computed(() =>
  files.value.filter(f => selected.value.has(f.path) && canSyncToWiki(f))
);

const selectedWikiActionableCount = computed(() => selectedWikiActionableFiles.value.length);

const activeTabLabel = computed(() =>
  tabs.find(tab => tab.value === activeTab.value)?.label || '当前筛选'
);

const emptyStateText = computed(() => {
  if (searchKeyword.value) {
    return `没有匹配"${searchKeyword.value}"的文件`;
  }
  if (activeTab.value === 'all') {
    return '暂无文件';
  }
  return `${activeTabLabel.value}暂无文件，可切换到"全部"查看`;
});

async function fetchFiles(tab, keyword = searchKeyword.value) {
  loading.value = true;
  error.value = '';
  try {
    const params = new URLSearchParams();
    if (keyword) params.set('q', keyword);
    if (tab !== 'all') params.set('days', tab);
    const url = tab === 'all'
      ? `/api/files/all${params.toString() ? `?${params.toString()}` : ''}`
      : `/api/files?${params.toString()}`;
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

function applySearch() {
  searchKeyword.value = searchInput.value;
  fetchFiles(activeTab.value, searchKeyword.value);
}

function clearSearch() {
  searchInput.value = '';
  searchKeyword.value = '';
  fetchFiles(activeTab.value, '');
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
  emit('upload', { paths: [...selected.value], syncWiki: syncWiki.value });
  selected.value = new Set();
}

function canSyncToWiki(file) {
  return !!(file?.uploaded && basename(file.path).startsWith('mfi_'));
}

function addSyncingPath(filePath) {
  const next = new Set(syncingPaths.value);
  next.add(filePath);
  syncingPaths.value = next;
}

function removeSyncingPath(filePath) {
  const next = new Set(syncingPaths.value);
  next.delete(filePath);
  syncingPaths.value = next;
}

async function requestWikiSync(filePath) {
  const res = await fetch('/api/sync-wiki', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function syncToWiki(filePath) {
  addSyncingPath(filePath);
  try {
    const data = await requestWikiSync(filePath);
    alert(data.message || '同步完成');
    await fetchFiles(activeTab.value, searchKeyword.value);
  } catch (e) {
    alert('同步失败: ' + (e?.message || '未知错误'));
  } finally {
    removeSyncingPath(filePath);
  }
}

async function syncSelectedToWiki() {
  const targets = selectedWikiActionableFiles.value;
  if (targets.length === 0) return;

  batchSyncing.value = true;
  batchSyncProgress.value = 0;

  const failures = [];
  for (const file of targets) {
    addSyncingPath(file.path);
    try {
      await requestWikiSync(file.path);
    } catch (e) {
      failures.push(`${basename(file.path)}: ${e?.message || '未知错误'}`);
    } finally {
      batchSyncProgress.value += 1;
      removeSyncingPath(file.path);
    }
  }

  batchSyncing.value = false;

  await fetchFiles(activeTab.value, searchKeyword.value);

  const successCount = targets.length - failures.length;
  if (failures.length === 0) {
    alert(`批量同步完成，共成功 ${successCount} 个文件`);
    return;
  }

  const preview = failures.slice(0, 5).join('\n');
  const more = failures.length > 5 ? `\n...另有 ${failures.length - 5} 个失败` : '';
  alert(`批量同步完成，成功 ${successCount} 个，失败 ${failures.length} 个\n${preview}${more}`);
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

async function copyLink(url) {
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

onMounted(() => fetchFiles(activeTab.value));
</script>

<style scoped>
.card { background: #fff; border-radius: 8px; padding: 16px; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
.toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; flex-wrap: wrap; gap: 8px; }
.search-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.search-input { flex: 1; min-width: 220px; padding: 8px 10px; border: 1px solid #d0d5dd; border-radius: 6px; font-size: .875rem; }
.search-input:focus { outline: none; border-color: #1677ff; box-shadow: 0 0 0 3px rgba(22,119,255,.12); }
.list-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; color: #667085; font-size: .8125rem; flex-wrap: wrap; }
.tabs { display: flex; gap: 4px; }
.tab { padding: 5px 14px; border: 1px solid #ddd; border-radius: 4px; background: #fafafa; cursor: pointer; font-size: .875rem; }
.tab.active { background: #1677ff; color: #fff; border-color: #1677ff; }
.btn-upload, .btn-search, .btn-secondary { padding: 5px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: .875rem; }
.btn-upload, .btn-search { background: #1677ff; color: #fff; }
.btn-secondary { background: #eef2f6; color: #344054; }
.btn-upload:disabled { background: #aaa; cursor: not-allowed; }
.btn-secondary:disabled { background: #f2f4f7; color: #98a2b3; cursor: not-allowed; }
.state { padding: 40px; text-align: center; color: #888; }
.state.error { color: #e53e3e; }
table { width: 100%; border-collapse: collapse; font-size: .875rem; }
th { text-align: left; padding: 8px 6px; border-bottom: 2px solid #eee; color: #666; font-weight: 500; }
td { padding: 7px 6px; border-bottom: 1px solid #f0f0f0; }
tr.uploaded td { color: #aaa; }
.name { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.size, .mtime { white-space: nowrap; }
.badge-done { background: #d1fae5; color: #065f46; padding: 2px 8px; border-radius: 10px; font-size: .75rem; }
.link-cell { display: flex; align-items: center; gap: 6px; }
.link { color: #1677ff; text-decoration: none; font-size: .8125rem; }
.link:hover { text-decoration: underline; }
.upload-actions { display: flex; align-items: center; gap: 12px; }
.sync-check { display: flex; align-items: center; gap: 4px; font-size: .875rem; color: #374151; cursor: pointer; }
.sync-check input { cursor: pointer; }
.btn-copy-sm { font-size: .75rem; padding: 1px 6px; border: 1px solid #d0d5dd; border-radius: 4px; background: #fff; cursor: pointer; color: #374151; }
.btn-copy-sm:hover { background: #f9fafb; }
.btn-sync-sm { font-size: .75rem; padding: 1px 6px; border: 1px solid #1677ff; border-radius: 4px; background: #fff; cursor: pointer; color: #1677ff; }
.btn-sync-sm:hover { background: #eff6ff; }
.btn-sync-sm:disabled { border-color: #93c5fd; color: #93c5fd; background: #f8fbff; cursor: not-allowed; }
.wiki-synced { font-size: .75rem; color: #059669; }
</style>
