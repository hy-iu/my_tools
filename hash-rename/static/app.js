const state = { sessionId: null, groups: [], planId: null, validationTimer: null, validationRevision: 0, choices: new Map() };
const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;'}[char]));
}
function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let n = value;
  let i = -1;
  do { n /= 1024; i += 1; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
}
function setStatus(text, error = false) {
  $('scan-status').textContent = text;
  $('scan-status').classList.toggle('error', error);
}
function normalizedPath(value) {
  return String(value).replaceAll('/', '\\').replace(/\\+$/, '').toLocaleLowerCase();
}
function isWithinRoot(path, root) {
  const child = normalizedPath(path);
  const parent = normalizedPath(root);
  return Boolean(parent) && (child === parent || child.startsWith(`${parent}\\`));
}
function defaultDonor(group) {
  const sourceRoot = $('source-root').value.trim();
  return group.files.find((file) => isWithinRoot(file.path, sourceRoot))?.id || group.files[0].id;
}
function isSameNameGroup(group) {
  return new Set(group.files.map((file) => file.name.toLocaleLowerCase())).size === 1;
}
function visibleGroups() {
  return $('show-same-name').checked ? state.groups : state.groups.filter((group) => !isSameNameGroup(group));
}
function choiceForGroup(group) {
  const saved = state.choices.get(group.id);
  if (saved) return {...saved, target_ids: [...saved.target_ids]};
  return {group_id: group.id, donor_id: defaultDonor(group), use_custom_name: false, custom_name: '', target_ids: []};
}
function choiceFromCard(card) {
  return {
    group_id: card.dataset.groupId,
    donor_id: card.querySelector('.donor-radio:checked')?.value,
    use_custom_name: card.querySelector('.custom-radio:checked') !== null,
    custom_name: card.querySelector('.custom-radio:checked') ? (card.querySelector('.custom-name')?.value || '') : '',
    target_ids: [...card.querySelectorAll('.target-check:checked')].map((item) => item.value),
  };
}
function rememberCardChoice(card) {
  const choice = choiceFromCard(card);
  state.choices.set(choice.group_id, choice);
  return choice;
}
function rememberVisibleChoices() {
  document.querySelectorAll('.group-card').forEach(rememberCardChoice);
}
async function request(path, options = {}) {
  const response = await fetch(path, { headers: {'Content-Type': 'application/json'}, ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}
function renderGroups() {
  const host = $('groups');
  host.className = 'groups';
  host.innerHTML = '';
  const groups = visibleGroups();
  const hidden = state.groups.length - groups.length;
  $('group-count').textContent = hidden ? `${groups.length} 组 · 已隐藏 ${hidden} 组` : `${groups.length} 组`;
  $('make-plan').disabled = groups.length === 0;
  $('select-all-targets').disabled = groups.length === 0;
  $('clear-conflicts').disabled = true;
  $('clear-same-name').disabled = true;
  $('clear-targets').disabled = groups.length === 0;
  $('apply-source-root').disabled = state.groups.length === 0;
  if (!groups.length) {
    host.className = 'groups empty-state';
    host.innerHTML = '<p>没有需要处理的异名哈希组。勾选“显示完全同名组”可以查看它们。</p>';
    return;
  }
  for (const group of groups) {
    const fragment = $('group-template').content.cloneNode(true);
    const card = fragment.querySelector('.group-card');
    card.dataset.groupId = group.id;
    const customRadio = card.querySelector('.custom-radio');
    customRadio.name = `donor-${group.id}`;
    customRadio.value = '__custom__';
    fragment.querySelector('.group-label').textContent = `${group.files.length} 个文件 · ${formatBytes(group.size)}`;
    fragment.querySelector('.digest').textContent = group.digest;
    const list = fragment.querySelector('.file-list');
    const choice = choiceForGroup(group);
    const donor = choice.use_custom_name ? '__custom__' : choice.donor_id;
    customRadio.checked = choice.use_custom_name;
    const customName = card.querySelector('.custom-name');
    customName.value = choice.custom_name;
    customName.disabled = !choice.use_custom_name;
    for (const file of group.files) {
      const row = document.createElement('div');
      row.className = `file-row${file.id === donor ? ' donor' : ''}`;
      row.dataset.fileId = file.id;
      row.innerHTML = `<input class="donor-radio" type="radio" name="donor-${group.id}" value="${escapeHtml(file.id)}" title="使用这个文件名">
        <input class="target-check" type="checkbox" value="${escapeHtml(file.id)}" title="改这个文件的名字" ${file.id === donor ? 'disabled' : ''}>
        <div><div class="file-name" title="${escapeHtml(file.name)}">[${escapeHtml(file.name)}]</div><div class="file-path" title="${escapeHtml(file.path)}">${escapeHtml(file.path)}</div></div>
        <div class="file-size">${formatBytes(file.size)}</div><div class="row-note" hidden></div>`;
      row.querySelector('.donor-radio').checked = file.id === donor;
      row.querySelector('.target-check').checked = choice.target_ids.includes(file.id) && file.id !== donor;
      list.appendChild(row);
    }
    card.querySelector('.choose-all').addEventListener('click', () => { setGroupTargets(card, true); rememberCardChoice(card); scheduleValidation(); });
    card.querySelector('.choose-none').addEventListener('click', () => { setGroupTargets(card, false); rememberCardChoice(card); scheduleValidation(); });
    list.addEventListener('change', (event) => {
      if (event.target.classList.contains('donor-radio')) {
        setDonor(card, event.target.value);
      }
      rememberCardChoice(card);
      scheduleValidation();
    });
    customRadio.addEventListener('change', () => {
      if (customRadio.checked) {
        setDonor(card, '__custom__');
        card.querySelector('.custom-name').focus();
      }
      rememberCardChoice(card);
      scheduleValidation();
    });
    card.querySelector('.custom-name').addEventListener('input', () => { rememberCardChoice(card); scheduleValidation(); });
    host.appendChild(fragment);
  }
}
function setDonor(card, selected) {
  for (const row of card.querySelectorAll('.file-row')) {
    const isDonor = row.dataset.fileId === selected;
    row.classList.toggle('donor', isDonor);
    row.querySelector('.donor-radio').checked = isDonor;
    const checkbox = row.querySelector('.target-check');
    checkbox.disabled = isDonor;
    if (isDonor) checkbox.checked = false;
  }
  const isCustom = selected === '__custom__';
  card.querySelector('.custom-radio').checked = isCustom;
  card.querySelector('.custom-name').disabled = !isCustom;
}
function setGroupTargets(card, enabled) {
  const donor = card.querySelector('.donor-radio:checked')?.value;
  for (const checkbox of card.querySelectorAll('.target-check')) {
    if (checkbox.value !== donor) checkbox.checked = enabled;
  }
}
function choicesFromUi() {
  return [...document.querySelectorAll('.group-card')].map(rememberCardChoice)
    .filter((choice) => (choice.donor_id || choice.use_custom_name) && choice.target_ids.length);
}
function invalidatePlan() {
  if (!state.planId) return;
  state.planId = null;
  $('execute').disabled = true;
  $('plan-count').textContent = '选择已变更，需重新生成计划';
  $('plan').className = '';
  $('plan').innerHTML = '<p>步骤 2 的选择已变更，请重新生成计划后再执行。</p>';
}
function scheduleValidation() {
  invalidatePlan();
  const revision = ++state.validationRevision;
  clearTimeout(state.validationTimer);
  if (state.sessionId) {
    applyValidation(null);
    setStatus('步骤 2：正在校验…');
  }
  state.validationTimer = setTimeout(() => validateStep2(revision), 220);
}
function setValidationStatus(choices, operations, conflicts) {
  const targets = choices.reduce((count, choice) => count + choice.target_ids.length, 0);
  if (!targets) return setStatus('步骤 2：尚未选择重命名目标');
  if (conflicts) return setStatus(`步骤 2：${conflicts} 个阻断冲突，请在对应文件行处理`, true);
  const sameName = targets - operations.length;
  const summary = [`已选 ${targets} 项`, `${operations.length} 项将改名`];
  if (sameName) summary.push(`${sameName} 项同名跳过`);
  setStatus(`步骤 2：${summary.join(' · ')} · 无阻断冲突`);
}
async function validateStep2(revision) {
  if (!state.sessionId) return;
  const choices = choicesFromUi();
  if (!choices.length) {
    applyValidation([]);
    return setValidationStatus(choices, [], 0);
  }
  try {
    const result = await request('/api/validate', {method: 'POST', body: JSON.stringify({session_id: state.sessionId, choices})});
    if (revision !== state.validationRevision) return;
    applyValidation(result.operations);
    setValidationStatus(choices, result.operations, result.conflicts);
  } catch (error) {
    if (revision !== state.validationRevision) return;
    setStatus(`步骤 2 校验失败：${error.message}`, true);
    renderProblems([{sourceId: '', message: error.message, path: '请检查当前自定义名称或名称来源'}]);
  }
}
function applyValidation(operations) {
  const validationReady = Array.isArray(operations);
  const bySource = new Map((operations || []).map((operation) => [operation.source_id, operation]));
  const problems = [];
  let sameNameCount = 0;
  for (const card of document.querySelectorAll('.group-card')) {
    let conflicts = 0;
    for (const row of card.querySelectorAll('.file-row')) {
      const operation = bySource.get(row.dataset.fileId);
      const message = operation?.conflict || '';
      const selected = row.querySelector('.target-check').checked;
      const sameName = validationReady && selected && !operation;
      row.classList.toggle('is-selected', selected);
      row.classList.toggle('is-same-name', sameName);
      row.classList.toggle('has-conflict', Boolean(message));
      const note = row.querySelector('.row-note');
      note.hidden = !message && !sameName;
      note.textContent = message || (sameName ? '同名：无需改名（将跳过）' : '');
      note.classList.toggle('warning', sameName && !message);
      if (message) {
        conflicts += 1;
        problems.push({sourceId: row.dataset.fileId, message, path: operation.source});
      }
      if (sameName) sameNameCount += 1;
    }
    card.querySelector('.group-conflicts').textContent = conflicts ? `${conflicts} 个冲突` : '';
  }
  renderProblems(problems);
  $('clear-conflicts').disabled = problems.length === 0;
  $('clear-same-name').disabled = sameNameCount === 0;
  renderConflictMap();
}
function renderProblems(problems) {
  const panel = $('problems-panel');
  const count = $('problem-count');
  const host = $('problems-list');
  count.textContent = `${problems.length} 个错误`;
  count.classList.toggle('has-problems', problems.length > 0);
  if (!problems.length) {
    host.innerHTML = '<p>步骤 2 的冲突会显示在这里。</p>';
    panel.classList.remove('expanded');
    $('toggle-problems').textContent = '展开';
    return;
  }
  panel.classList.add('expanded');
  $('toggle-problems').textContent = '收起';
  host.innerHTML = problems.map((item) => `<button class="problem-item" data-source-id="${escapeHtml(item.sourceId)}"><span class="problem-icon">×</span><span><span class="problem-message">${escapeHtml(item.message)}</span><span class="problem-path">${escapeHtml(item.path)}</span></span></button>`).join('');
  host.querySelectorAll('.problem-item').forEach((button) => button.addEventListener('click', () => focusSource(button.dataset.sourceId)));
}
function renderConflictMap() {
  const host = $('map-markers');
  const cards = [...document.querySelectorAll('.group-card')];
  host.innerHTML = '';
  if (!cards.length) return;
  cards.forEach((card, index) => {
    const conflicts = card.querySelectorAll('.file-row.has-conflict').length;
    const sameName = card.querySelectorAll('.file-row.is-same-name').length;
    const selected = card.querySelectorAll('.file-row.is-selected:not(.is-same-name)').length;
    const marker = document.createElement('button');
    marker.className = `map-marker${conflicts ? ' conflict' : sameName && selected ? ' mixed' : sameName ? ' same-name' : selected ? ' selected' : ''}`;
    marker.style.top = `${(index / cards.length) * 100}%`;
    marker.style.height = `${Math.max(3, 100 / cards.length)}%`;
    marker.title = conflicts ? `${conflicts} 个冲突` : sameName && selected ? `${selected} 项将改名 · ${sameName} 项同名跳过` : sameName ? `${sameName} 项同名跳过` : selected ? `${selected} 项将改名` : '未处理';
    marker.addEventListener('click', () => {
      card.scrollIntoView({behavior: 'smooth', block: 'center'});
      const first = card.querySelector('.file-row.has-conflict') || card;
      first.classList.add('flash');
      setTimeout(() => first.classList.remove('flash'), 1100);
    });
    host.appendChild(marker);
  });
}
function focusSource(sourceId) {
  const row = document.querySelector(`.file-row[data-file-id="${CSS.escape(sourceId)}"]`);
  if (!row) return;
  row.scrollIntoView({behavior: 'smooth', block: 'center'});
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 1100);
}
async function scan() {
  const roots = $('roots').value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  if (!roots.length) return setStatus('请至少填写一个文件夹路径', true);
  $('scan').disabled = true; $('make-plan').disabled = true; $('execute').disabled = true;
  $('progress-bar').style.width = '0%'; setStatus('正在启动扫描…');
  try {
    const started = await request('/api/scan', {method: 'POST', body: JSON.stringify({roots, algorithm: $('algorithm').value, workers: Number($('workers').value) || 4})});
    await pollJob(started.job_id);
  } catch (error) { setStatus(error.message, true); $('scan').disabled = false; }
}
async function pollJob(jobId) {
  const job = await request(`/api/job/${jobId}`);
  const p = job.progress || {};
  const denominator = Math.max(p.files_seen || 0, p.hash_candidates || 0, 1);
  const done = Math.min(100, Math.round(((p.hashed || 0) / denominator) * 100));
  $('progress-bar').style.width = `${job.status === 'done' ? 100 : done}%`;
  setStatus(`${p.phase || job.status} · 已发现 ${p.files_seen || 0} 个文件 · 已计算 ${p.hashed || 0}/${p.hash_candidates || 0} 个哈希`);
  if (job.status === 'running' || job.status === 'queued') return setTimeout(() => pollJob(jobId), 350);
  $('scan').disabled = false;
  if (job.status === 'error') return setStatus(job.error || '扫描失败', true);
  state.sessionId = job.session_id;
  const session = await request(`/api/session/${state.sessionId}`);
  state.groups = session.groups;
  state.choices = new Map();
  state.validationRevision += 1;
  clearTimeout(state.validationTimer);
  state.planId = null;
  $('plan').innerHTML = '<p>还没有重命名计划。</p>';
  $('plan-count').textContent = '未生成计划';
  $('execute').disabled = true;
  renderGroups();
  applyValidation([]);
  setStatus(`扫描完成：${session.groups.length} 组重复文件`);
}
async function makePlan() {
  if (!state.sessionId) return;
  try {
    const result = await request('/api/plan', {method: 'POST', body: JSON.stringify({session_id: state.sessionId, choices: choicesFromUi()})});
    state.planId = result.plan_id;
    $('plan-count').textContent = `${result.operations.length} 个操作 · ${result.conflicts} 个冲突`;
    $('execute').disabled = result.operations.length === 0 || result.conflicts > 0;
    renderPlan(result.operations);
  } catch (error) { setStatus(error.message, true); }
}
function renderPlan(operations) {
  const host = $('plan');
  if (!operations.length) { host.innerHTML = '<p>没有勾选要改名的目标文件。</p>'; return; }
  host.className = 'plan';
  host.innerHTML = `<table class="plan-table"><thead><tr><th>当前名称</th><th>改为</th><th>状态</th></tr></thead><tbody>${operations.map((item) => `<tr><td><code>${escapeHtml(item.source)}</code></td><td><code>${escapeHtml(item.destination)}</code></td><td class="${item.conflict ? 'conflict' : 'ok'}">${item.conflict ? escapeHtml(item.conflict) : '可执行'}</td></tr>`).join('')}</tbody></table>`;
}
async function executePlan() {
  if (!state.planId || !confirm('确认执行这批重命名？文件内容不会复制或删除。')) return;
  $('execute').disabled = true;
  try { await request('/api/execute', {method: 'POST', body: JSON.stringify({plan_id: state.planId})}); setStatus('重命名完成，可在下方撤销'); await loadHistory(); }
  catch (error) { setStatus(error.message, true); $('execute').disabled = false; }
}
async function loadHistory() {
  const items = await request('/api/history');
  const host = $('history');
  if (!items.length) { host.innerHTML = '<p>暂无执行记录。</p>'; return; }
  host.innerHTML = items.reverse().map((item) => `<div class="history-item"><div><strong>${item.operations.length} 个重命名</strong><br><code>${escapeHtml(item.created)} · ${escapeHtml(item.id.slice(0, 12))}</code></div><button class="secondary undo" data-id="${escapeHtml(item.id)}">撤销</button></div>`).join('');
  host.querySelectorAll('.undo').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('确认撤销这笔重命名？')) return;
    button.disabled = true;
    try { await request('/api/undo', {method: 'POST', body: JSON.stringify({transaction_id: button.dataset.id})}); setStatus('已撤销'); await loadHistory(); }
    catch (error) { setStatus(error.message, true); button.disabled = false; }
  }));
}
$('scan').addEventListener('click', scan);
$('make-plan').addEventListener('click', makePlan);
$('execute').addEventListener('click', executePlan);
$('refresh-history').addEventListener('click', () => loadHistory().catch((error) => setStatus(error.message, true)));
$('select-all-targets').addEventListener('click', () => {
  document.querySelectorAll('.group-card').forEach((card) => { setGroupTargets(card, true); rememberCardChoice(card); });
  scheduleValidation();
});
$('clear-conflicts').addEventListener('click', () => {
  document.querySelectorAll('.file-row.has-conflict .target-check:checked').forEach((checkbox) => { checkbox.checked = false; });
  rememberVisibleChoices();
  scheduleValidation();
});
$('clear-same-name').addEventListener('click', () => {
  document.querySelectorAll('.file-row.is-same-name .target-check:checked').forEach((checkbox) => { checkbox.checked = false; });
  rememberVisibleChoices();
  scheduleValidation();
});
$('clear-targets').addEventListener('click', () => {
  document.querySelectorAll('.group-card').forEach((card) => { setGroupTargets(card, false); rememberCardChoice(card); });
  scheduleValidation();
});
$('show-same-name').addEventListener('change', () => {
  // The rendered cards change here. Keep their choices, discard annotations for
  // cards that just disappeared, then validate precisely the newly visible set.
  rememberVisibleChoices();
  state.validationRevision += 1;
  clearTimeout(state.validationTimer);
  renderGroups();
  applyValidation(null);
  setStatus('步骤 2：正在按当前显示范围重新校验…');
  scheduleValidation();
});
$('apply-source-root').addEventListener('click', () => {
  for (const card of document.querySelectorAll('.group-card')) {
    const group = state.groups.find((item) => item.id === card.dataset.groupId);
    if (group) {
      setDonor(card, defaultDonor(group));
      rememberCardChoice(card);
    }
  }
  scheduleValidation();
});
$('toggle-problems').addEventListener('click', () => {
  const panel = $('problems-panel');
  panel.classList.toggle('expanded');
  $('toggle-problems').textContent = panel.classList.contains('expanded') ? '收起' : '展开';
});
loadHistory().catch(() => {});
