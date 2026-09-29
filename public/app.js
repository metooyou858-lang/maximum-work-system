const app = document.querySelector('#app');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const fmt = value => value ? new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const clock = value => new Date(value).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const localMode = Boolean(window.demoApi);
let token = sessionStorage.getItem('maximum-token');
let data;
let busy = false;
let errorMessage = '';
let arrivalMessage = '';
let scenario = 'onsite';
let reportOpen = false;
let lastSignature = '';
let poll;
const query = new URLSearchParams(location.search);
let room = query.get('room') || localStorage.getItem('maximum-last-room');
let role = query.get('role') === 'manager' ? 'manager' : 'employee';

async function api(path, input) {
  if (localMode) return window.demoApi(path, input, token);
  let response;
  try {
    response = await fetch(path, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
  } catch { throw new Error('Нет связи с сервером. Проверьте подключение и повторите попытку. Заполненные поля сохранены.'); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Не удалось выполнить действие.');
  return result;
}

function saveDraft() {
  const form = document.querySelector('#report-form');
  if (!form || !room) return;
  const draft = Object.fromEntries(new FormData(form));
  localStorage.setItem(`maximum-draft-${room}`, JSON.stringify(draft));
}
function draft() {
  try { return JSON.parse(localStorage.getItem(`maximum-draft-${room}`)) || {}; } catch { return {}; }
}
function signature(value) { return JSON.stringify([value.visit, value.report, value.attempts, value.role]); }
function accept(value) {
  data = value;
  room = value.room;
  role = value.role;
  lastSignature = signature(value);
  localStorage.setItem('maximum-last-room', room);
  history.replaceState(null, '', `?room=${encodeURIComponent(room)}&role=${role}`);
}
async function enter(nextRole = role, newRoom = false) {
  if (busy) return;
  saveDraft();
  busy = true;
  document.querySelectorAll('button').forEach(button => button.disabled = true);
  try {
    const result = await api('/api/demo/session', { role: nextRole, ...(newRoom || !room ? {} : { room }) });
    token = result.token;
    sessionStorage.setItem('maximum-token', token);
    accept(result);
    errorMessage = '';
    arrivalMessage = '';
    reportOpen = false;
    render();
    startPolling();
  } catch (error) {
    if (data) { errorMessage = error.message; render(); }
    else renderWelcome(error.message);
  } finally { busy = false; document.querySelectorAll('button').forEach(button => button.disabled = false); }
}

function renderWelcome(message = '') {
  app.innerHTML = `<main class="landing"><h1>Показ рабочего сценария</h1><p>Объект → прибытие → персональный отчёт.</p>${message ? `<div class="error" role="alert">${escapeHtml(message)}</div>` : ''}<div class="panel"><h2>Начать с сотрудника</h2><p>Проверьте отметку на объекте и за его пределами, затем сдайте отчёт и переключитесь на руководителя.</p><button class="primary" id="begin">Начать новый показ</button></div><p class="subtle">Только вымышленные данные. Геопозиция моделируется, координаты телефона не запрашиваются.</p></main>`;
  document.querySelector('#begin').onclick = () => enter('employee', true);
}

function render() {
  const manager = role === 'manager';
  app.innerHTML = `<main class="workspace">
    <nav class="toolbar" aria-label="Управление показом"><div class="role-tabs" aria-label="Роль"><button data-role="employee" aria-pressed="${!manager}">Сотрудник</button><button data-role="manager" aria-pressed="${manager}">Руководитель</button></div><div class="actions"><button id="new-demo">Новый показ</button>${!localMode ? '<button id="share-toggle">Открыть на другом устройстве</button>' : ''}</div></nav>
    <div class="notice">Тестовый сценарий · вымышленные данные и геопозиция.${localMode ? ' Результат сохраняется на этом телефоне.' : ''}</div>
    <div id="share-area"></div>
    <header class="page-head"><div class="step">${manager ? 'МОИ ОБЪЕКТЫ' : escapeHtml(data.employee)}</div><h1>${escapeHtml(data.object.name)}</h1><p>${escapeHtml(data.object.address)}</p></header>
    <div id="top-error" role="alert">${errorMessage ? `<div class="error">${escapeHtml(errorMessage)}</div>` : ''}</div>
    ${manager ? managerView() : employeeView()}
    <div class="connection" id="connection" role="status">${localMode ? 'Демонстрация на одном устройстве. Это не рабочая система учёта.' : 'Данные сохранены на сервере. Обновление каждые 3 секунды.'}</div>
  </main>`;
  app.querySelectorAll('[data-role]').forEach(button => button.onclick = () => enter(button.dataset.role));
  document.querySelector('#new-demo').onclick = () => enter('employee', true);
  document.querySelector('#share-toggle')?.addEventListener('click', showShare);
  document.querySelector('#scenario')?.addEventListener('change', event => { scenario = event.target.value; arrivalMessage = ''; document.querySelector('#arrival-feedback').innerHTML = ''; });
  document.querySelector('#arrive')?.addEventListener('click', arrive);
  document.querySelector('#open-report')?.addEventListener('click', () => { reportOpen = true; render(); document.querySelector('#report-form').scrollIntoView({ block: 'start', behavior: 'smooth' }); });
  document.querySelector('#report-form')?.addEventListener('input', saveDraft);
  document.querySelector('#work-type')?.addEventListener('change', () => { updateUnits(); saveDraft(); });
  document.querySelector('#unit')?.addEventListener('change', updateQuantityStep);
  document.querySelector('#report-form')?.addEventListener('submit', submitReport);
  if (document.querySelector('#report-form')) updateQuantityStep();
}

function employeeView() {
  const { visit, report } = data;
  return `<ol class="progress" aria-label="Этапы"><li class="${visit ? 'done' : 'active'}">1. Прибытие${visit ? ' ✓' : ''}</li><li class="${report ? 'done' : visit ? 'active' : ''}">2. Отчёт${report ? ' ✓' : ''}</li><li class="${report ? 'active' : ''}">3. Принят</li></ol>
  <div class="columns"><div>
    ${!visit ? arrivalPanel() : report ? `<section class="success" role="status"><h2>Отчёт принят</h2><p>${fmt(report.submitted_at)}</p><p>Руководитель видит ваш отчёт. Сценарий завершён.</p></section>${reportDetails()}` : `<section class="success"><h2>Прибытие зафиксировано</h2><p>${fmt(visit.arrived_at)} · на объекте</p></section>${reportOpen ? reportForm() : `<section class="panel"><h2>После работы сдайте отчёт</h2><p>Укажите вид и объём выполненных работ. Геопозиция при сдаче отчёта не запрашивается.</p><button id="open-report" class="primary full">Заполнить отчёт</button></section>`}`}
  </div><aside>${objectInfo()}${visit ? `<section class="panel"><h2>Отметки</h2><dl class="facts"><div><dt>Прибытие</dt><dd>${fmt(visit.arrived_at)}</dd></div><div><dt>Сдача отчёта</dt><dd>${report ? fmt(report.submitted_at) : 'Ещё не сдан'}</dd></div></dl><p class="caption">Фактическое время убытия в этой версии не фиксируется.</p></section>` : ''}</aside></div>`;
}

function arrivalPanel() {
  return `<section class="panel"><div class="section-head"><h2>Отметьте прибытие</h2></div><p>Отметка доступна в радиусе ${data.object.radius} м от объекта.</p>
    <div class="control"><label for="scenario">Где сотрудник? Условие демонстрации</label><select id="scenario">
    ${[['onsite', 'На объекте'], ['offsite', 'Вне объекта'], ['unavailable', 'Геопозиция недоступна'], ['denied', 'Доступ к геопозиции запрещён'], ['inaccurate', 'Низкая точность геопозиции']].map(([value, text]) => `<option value="${value}" ${scenario === value ? 'selected' : ''}>${text}</option>`).join('')}</select><span class="caption">Выберите ситуацию, затем нажмите «Прибыл».</span></div>
    <button id="arrive" class="primary full">Прибыл</button><div id="arrival-feedback" role="status">${arrivalMessage ? `<div class="error">${escapeHtml(arrivalMessage)}</div>` : ''}</div>
    <p class="caption">Отчёт станет доступен после успешной отметки прибытия.</p></section>`;
}

function objectInfo() {
  return `<section class="panel"><h2>Задание на объекте</h2><p>${escapeHtml(data.object.task)}</p><dl class="facts"><div><dt>Назначен</dt><dd>${escapeHtml(data.employee)}</dd></div></dl><div class="line"><h3>Закреплённое оборудование</h3><ul class="list">${data.object.equipment.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div></section>`;
}

function reportForm() {
  const saved = draft();
  const workType = Object.hasOwn(data.workTypes, saved.workType) ? saved.workType : 'drilling';
  return `<section class="panel"><h2>Персональный отчёт</h2><p class="caption">Пробная форма для встречи. Итоговую форму предоставит заказчик. Вводите только тестовые сведения.</p>
  <form id="report-form"><div class="control"><label for="work-type">Вид работ</label><select id="work-type" name="workType">${Object.entries(data.workTypes).map(([key, value]) => `<option value="${key}" ${key === workType ? 'selected' : ''}>${escapeHtml(value.label)}</option>`).join('')}</select></div>
  <div class="form-row"><div class="control"><label for="quantity">Объём работ</label><input id="quantity" name="quantity" type="number" inputmode="decimal" min="0.001" max="100000" step="any" required value="${escapeHtml(saved.quantity || '')}" placeholder="Например, 4"></div><div class="control"><label for="unit">Единица</label><select id="unit" name="unit">${data.workTypes[workType].units.map(unit => `<option ${unit === saved.unit ? 'selected' : ''}>${escapeHtml(unit)}</option>`).join('')}</select></div></div>
  <div class="control"><label for="parameters">Параметры выполненных работ</label><textarea id="parameters" name="parameters" maxlength="2000" required placeholder="Например: бетон, диаметр 120 мм, глубина 300 мм">${escapeHtml(saved.parameters || '')}</textarea></div>
  <div class="control"><label for="comment">Комментарий <span class="subtle">· необязательно</span></label><textarea id="comment" name="comment" maxlength="2000" placeholder="Уточнения по результату работ">${escapeHtml(saved.comment || '')}</textarea></div>
  <div id="report-error" role="alert"></div><button class="primary full" type="submit" id="submit-report">Сдать отчёт</button><p class="caption">Сохраним отчёт и время его сдачи. Повторной геопроверки нет.</p></form></section>`;
}
function updateUnits() {
  const key = document.querySelector('#work-type').value;
  document.querySelector('#unit').innerHTML = data.workTypes[key].units.map(unit => `<option>${escapeHtml(unit)}</option>`).join('');
  updateQuantityStep();
}
function updateQuantityStep() {
  const quantity = document.querySelector('#quantity');
  const pieces = document.querySelector('#unit').value === 'шт.';
  quantity.step = pieces ? '1' : 'any';
  quantity.min = pieces ? '1' : '0.001';
}

function reportDetails() {
  const r = data.report;
  return `<section class="panel"><div class="section-head"><h2>Принятый отчёт</h2></div><dl class="facts"><div><dt>Сотрудник</dt><dd>${escapeHtml(r.employee)}</dd></div><div><dt>Вид работ</dt><dd>${escapeHtml(r.work_label)}</dd></div><div><dt>Объём</dt><dd><strong>${escapeHtml(r.quantity)} ${escapeHtml(r.unit)}</strong></dd></div><div><dt>Сдан</dt><dd>${fmt(r.submitted_at)}</dd></div></dl><div class="line"><h3>Параметры работ</h3><div class="report-copy">${escapeHtml(r.parameters)}</div></div>${r.comment ? `<div class="line"><h3>Комментарий</h3><div class="report-copy">${escapeHtml(r.comment)}</div></div>` : ''}</section>`;
}

function managerView() {
  const { visit, report, attempts } = data;
  return `<div class="columns"><div><section class="panel"><div class="section-head"><h2>${escapeHtml(data.employee)}</h2></div><p><strong>${report ? 'Отчёт принят' : visit ? 'Прибытие отмечено · ожидается отчёт' : 'Прибытие ещё не отмечено'}</strong></p><dl class="facts"><div><dt>Прибытие</dt><dd>${visit ? fmt(visit.arrived_at) : 'Нет отметки'}</dd></div><div><dt>Геопроверка</dt><dd>${visit ? `На объекте · ${visit.distance} м от точки` : 'Присутствие не подтверждено'}</dd></div><div><dt>Сдача отчёта</dt><dd>${report ? fmt(report.submitted_at) : 'Ещё не сдан'}</dd></div></dl><p class="caption">Время сдачи отчёта не является временем убытия. Длительность присутствия не рассчитывается.</p></section>
  ${report ? reportDetails() : `<section class="panel"><h2>Отчёт сотрудника</h2><div class="empty">Пока не сдан. Переключитесь на сотрудника и пройдите сценарий.</div></section>`}</div>
  <aside><section class="panel"><h2>События на объекте</h2><div class="line"><ol class="timeline">${report ? `<li><time>${fmt(report.submitted_at)}</time><strong>Отчёт принят</strong><p>Сохранён персональный отчёт сотрудника.</p></li>` : ''}${attempts.map(attempt => `<li><time>${fmt(attempt.created_at)}</time><strong>${attempt.outcome === 'accepted' ? 'Прибытие подтверждено' : 'Попытка отметки не принята'}</strong><p>${escapeHtml(attempt.message)}</p></li>`).join('')}${!attempts.length ? '<li class="empty">Событий пока нет.</li>' : ''}</ol></div></section>${objectInfo()}</aside></div>`;
}

async function arrive() {
  if (busy) return;
  busy = true;
  const button = document.querySelector('#arrive');
  button.disabled = true; button.textContent = 'Проверяем местоположение…';
  try {
    const result = await api('/api/arrival', { scenario });
    accept(result);
    arrivalMessage = result.accepted ? '' : result.message;
    errorMessage = '';
    render();
  } catch (error) {
    document.querySelector('#arrival-feedback').innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    button.disabled = false; button.textContent = 'Прибыл';
  } finally { busy = false; }
}

async function submitReport(event) {
  event.preventDefault();
  if (busy) return;
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  saveDraft();
  const input = Object.fromEntries(new FormData(form));
  input.quantity = Number(input.quantity);
  if (!input.parameters.trim()) { document.querySelector('#report-error').innerHTML = '<div class="error">Укажите параметры выполненных работ.</div>'; return; }
  busy = true;
  const button = document.querySelector('#submit-report');
  button.disabled = true; button.textContent = 'Отправляем отчёт…';
  try {
    const result = await api('/api/report', input);
    accept(result);
    localStorage.removeItem(`maximum-draft-${room}`);
    errorMessage = '';
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    document.querySelector('#report-error').innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
    button.disabled = false; button.textContent = 'Повторить отправку отчёта';
  } finally { busy = false; }
}

function showShare() {
  const area = document.querySelector('#share-area');
  if (area.innerHTML) { area.innerHTML = ''; return; }
  const url = `${location.origin}/?room=${encodeURIComponent(room)}&role=employee`;
  area.innerHTML = `<section class="panel"><h2>Тот же показ на другом устройстве</h2><p class="caption">Оба устройства должны иметь доступ к адресу сервера. Локальный адрес 127.0.0.1 работает только на этом компьютере.</p><div class="share"><input id="share-url" readonly aria-label="Ссылка на показ" value="${escapeHtml(url)}"><button id="copy-link">Копировать ссылку</button></div><div id="copy-state" role="status"></div></section>`;
  document.querySelector('#copy-link').onclick = async () => {
    try { await navigator.clipboard.writeText(url); document.querySelector('#copy-state').textContent = 'Ссылка скопирована.'; }
    catch { document.querySelector('#share-url').select(); document.querySelector('#copy-state').textContent = 'Выделенная ссылка готова для копирования.'; }
  };
}
function startPolling() {
  clearInterval(poll);
  poll = setInterval(async () => {
    if (busy || document.hidden) return;
    try {
      const value = await api('/api/state');
      if (signature(value) !== lastSignature) { saveDraft(); accept(value); render(); }
      const connection = document.querySelector('#connection');
      if (connection) { connection.classList.remove('failed'); connection.textContent = localMode ? 'Данные демонстрации сохранены в этом браузере.' : `Данные актуальны на ${clock(value.serverTime)}. Обновление автоматически.`; }
    } catch {
      const connection = document.querySelector('#connection');
      if (connection) { connection.classList.add('failed'); connection.textContent = 'Нет связи. Последние полученные данные остаются на экране.'; }
    }
  }, 3000);
}

enter(role);
