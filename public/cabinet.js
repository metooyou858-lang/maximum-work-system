const root = document.querySelector('#cabinet');
const resources = {
  objects: { title: 'Мои объекты', singular: 'объект', action: 'Добавить объект', columns: [['address', 'Адрес объекта']], fields: [['address', 'Адрес объекта', 'text']] },
  employees: { title: 'Сотрудники', singular: 'сотрудника', action: 'Добавить сотрудника', columns: [['full_name', 'ФИО'], ['birth_date', 'Дата рождения'], ['clothing_size', 'Одежда'], ['shoe_size', 'Обувь']], fields: [['full_name', 'ФИО', 'text'], ['birth_date', 'Дата рождения', 'date'], ['clothing_size', 'Размер одежды', 'select', ['40', '42', '44', '46', '48', '50', '52', '54', '56', '58', '60', '62']], ['shoe_size', 'Размер обуви', 'select', ['35', '36', '37', '38', '39', '40', '41', '42', '43', '44', '45', '46', '47']]] },
  equipment: { title: 'Оборудование', singular: 'оборудование', action: 'Добавить оборудование', columns: [['name', 'Название'], ['inventory_number', 'Инвентарный номер'], ['equipment_type', 'Тип оборудования']], fields: [['name', 'Название', 'text'], ['inventory_number', 'Инвентарный номер', 'text'], ['equipment_type', 'Тип оборудования', 'text']] },
};
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
let token = sessionStorage.getItem('cabinet-manager-token');
let current = 'objects';
let items = [];
let editing = null;
let menuOpen = false;

async function api(path, input, method = 'POST') {
  let response;
  try {
    response = await fetch(path, { method, signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  } catch { throw new Error('Не удалось связаться с сервером за 10 секунд. Проверьте, что приложение запущено, и повторите попытку.'); }
  let result;
  try { result = await response.json(); } catch { throw new Error('Сервер вернул некорректный ответ. Перезапустите приложение и повторите попытку.'); }
  if (!response.ok) throw new Error(result.error || 'Не удалось выполнить действие.');
  return result;
}
async function enter() {
  if (token) return;
  const session = await api('/api/demo/session', { role: 'manager' });
  token = session.token;
  sessionStorage.setItem('cabinet-manager-token', token);
}
async function load(renewSession = true) {
  try {
    await enter();
    items = await api(`/api/cabinet/${current}`, undefined, 'GET');
    editing = null;
    render();
  } catch (error) {
    if (renewSession && error.message.includes('Сеанс показа истёк')) {
      token = null;
      sessionStorage.removeItem('cabinet-manager-token');
      return load(false);
    }
    throw error;
  }
}
function nav() {
  return `<aside class="sidebar ${menuOpen ? 'open' : ''}" aria-label="Основные разделы"><div class="sidebar-head"><span>Учёт работ</span><button class="close-menu" id="close-menu" aria-label="Закрыть меню">×</button></div><nav>${Object.entries(resources).map(([key, resource]) => `<button class="nav-item ${key === current ? 'active' : ''}" data-section="${key}" aria-current="${key === current ? 'page' : 'false'}">${resource.title}</button>`).join('')}</nav><p class="sidebar-note">Рабочий набросок. Используйте только тестовые данные.</p></aside>`;
}
function list() {
  const resource = resources[current];
  return `<section class="page"><header class="page-head"><div><h1>${resource.title}</h1><p>${items.length ? `Записей: ${items.length}` : 'Записей пока нет'}</p></div><button class="primary" id="create">${resource.action}</button></header>${items.length ? `<div class="table-wrap"><table><thead><tr>${resource.columns.map(([, label]) => `<th>${label}</th>`).join('')}<th aria-label="Открыть карточку"></th></tr></thead><tbody>${items.map(item => `<tr data-record="${item.id}" tabindex="0">${resource.columns.map(([field]) => `<td>${escapeHtml(format(field, item[field]))}</td>`).join('')}<td class="open-mark" aria-hidden="true">›</td></tr>`).join('')}</tbody></table></div>` : `<section class="empty-state"><h2>Здесь пока пусто</h2><p>Создайте первую запись кнопкой в правом верхнем углу — она появится в общем списке и будет готова к будущим связям.</p></section>`}</section>`;
}
function format(field, value) {
  if (field === 'birth_date' && value) return new Date(`${value}T00:00:00`).toLocaleDateString('ru-RU');
  return value;
}
function editor() {
  const resource = resources[current];
  const item = editing || {};
  const title = item.id ? `Карточка: ${item.full_name || item.name || item.address}` : resource.action;
  const field = ([name, label, type, options]) => {
    const value = item[name] || '';
    if (type !== 'select') return `<div class="control"><label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" maxlength="200" required value="${escapeHtml(value)}"></div>`;
    const isKnown = options.includes(value);
    return `<div class="control"><label for="${name}">${label}</label><select id="${name}" name="${name}" required><option value="" disabled ${value ? '' : 'selected'}>Выберите размер</option>${!isKnown && value ? `<option value="${escapeHtml(value)}" selected>${escapeHtml(value)}</option>` : ''}${options.map(option => `<option value="${option}" ${option === value ? 'selected' : ''}>${option}</option>`).join('')}</select></div>`;
  };
  const objectLocation = current === 'objects' ? `<section class="object-location" aria-labelledby="map-title"><h2 id="map-title">Точка объекта</h2><p>Поставьте маркер касанием карты. Радиус — допустимое расстояние для отметки прибытия.</p><div id="object-map-status" class="map-status" role="status">Подключаем карту…</div><div id="object-map" class="object-map" aria-label="Карта для выбора точки объекта"></div><input id="latitude" name="latitude" type="hidden" value="${escapeHtml(item.latitude ?? '')}"><input id="longitude" name="longitude" type="hidden" value="${escapeHtml(item.longitude ?? '')}"><p id="object-point" class="map-point">${item.latitude !== null && item.latitude !== undefined && item.longitude !== null && item.longitude !== undefined ? `Точка: ${Number(item.latitude).toFixed(6)}, ${Number(item.longitude).toFixed(6)}` : 'Точка пока не выбрана.'}</p><div class="control"><label for="radius">Радиус объекта, м</label><input id="radius" name="radius" type="number" inputmode="numeric" min="10" max="5000" step="1" required value="${escapeHtml(item.radius ?? 150)}"></div></section>` : '';
  return `<section class="page form-page"><header class="page-head"><div><button class="back" id="cancel">← К списку</button><h1>${escapeHtml(title)}</h1></div></header><form id="record-form">${resource.fields.map(field).join('')}${objectLocation}${current === 'employees' ? `<section class="privacy"><h2>Персональные данные</h2><p>Версия политики устанавливается системой: «Тестовая политика 1.0». После утверждения документа она будет заменена на его номер и дату. Фотография и загрузка документов отключены: это тестовая среда.</p><label class="check"><input id="privacy-confirmed" type="checkbox" ${item.privacy_confirmed_at ? 'checked' : ''} required> Подтверждение ознакомления с политикой зафиксировано</label></section>` : ''}<div id="form-error" role="alert"></div><div class="form-actions"><button type="button" id="cancel-bottom">Отменить</button><button class="primary" type="submit">${item.id ? 'Сохранить изменения' : 'Создать карточку'}</button></div></form></section>`;
}
function render(message = '') {
  root.innerHTML = `<div class="shell">${nav()}<div class="scrim ${menuOpen ? 'visible' : ''}" id="scrim"></div><main class="content"><header class="mobile-head"><button id="open-menu" aria-label="Открыть меню">Меню</button><span>${resources[current].title}</span></header>${message ? `<div class="error" role="alert">${escapeHtml(message)}</div>` : ''}${editing === null ? list() : editor()}</main></div>`;
  document.querySelectorAll('[data-section]').forEach(button => button.onclick = async () => { current = button.dataset.section; menuOpen = false; try { await load(); } catch (error) { render(error.message); } });
  document.querySelector('#open-menu')?.addEventListener('click', () => { menuOpen = true; render(); });
  document.querySelector('#close-menu')?.addEventListener('click', () => { menuOpen = false; render(); });
  document.querySelector('#scrim')?.addEventListener('click', () => { menuOpen = false; render(); });
  document.querySelector('#create')?.addEventListener('click', () => { editing = {}; render(); });
  document.querySelectorAll('[data-record]').forEach(row => { const open = () => { editing = items.find(item => item.id === Number(row.dataset.record)); render(); }; row.onclick = open; row.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } }; });
  document.querySelector('#cancel')?.addEventListener('click', () => { editing = null; render(); });
  document.querySelector('#cancel-bottom')?.addEventListener('click', () => { editing = null; render(); });
  document.querySelector('#record-form')?.addEventListener('submit', save);
  if (editing !== null && current === 'objects') initializeObjectMap().catch(error => { const status = document.querySelector('#object-map-status'); if (status) status.textContent = error.message; });
}

let yandexMapsPromise;
function loadYandexMaps(scriptUrl) {
  if (window.ymaps3) return Promise.resolve();
  if (!yandexMapsPromise) yandexMapsPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = scriptUrl;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Яндекс Карты не загрузились. После смены ограничения Referer Яндекс может применять настройку до 15 минут; затем проверьте разрешённый HTTPS-адрес тестового контура.'));
    document.head.append(script);
  });
  return yandexMapsPromise;
}
async function initializeObjectMap() {
  const config = await api('/api/cabinet/map-config', undefined, 'GET');
  const status = document.querySelector('#object-map-status');
  if (!config.enabled) { status.textContent = 'Яндекс Карты пока не подключены: укажите ключ YANDEX_MAPS_API_KEY в окружении сервера.'; return; }
  await loadYandexMaps(config.scriptUrl);
  await window.ymaps3.ready;
  const root = document.querySelector('#object-map');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = 'true';
  const latitude = Number(document.querySelector('#latitude').value);
  const longitude = Number(document.querySelector('#longitude').value);
  const hasPoint = Number.isFinite(latitude) && Number.isFinite(longitude);
  const map = new window.ymaps3.YMap(root, { location: { center: hasPoint ? [longitude, latitude] : [37.6176, 55.7558], zoom: hasPoint ? 16 : 10 } });
  map.addChild(new window.ymaps3.YMapDefaultSchemeLayer({}));
  map.addChild(new window.ymaps3.YMapDefaultFeaturesLayer({ zIndex: 1800 }));
  let marker;
  const setPoint = coordinates => {
    const [longitude, latitude] = coordinates;
    document.querySelector('#latitude').value = latitude.toFixed(6);
    document.querySelector('#longitude').value = longitude.toFixed(6);
    document.querySelector('#object-point').textContent = `Точка: ${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
    if (marker) map.removeChild(marker);
    const pin = document.createElement('div');
    pin.className = 'map-pin';
    pin.textContent = 'Объект';
    marker = new window.ymaps3.YMapMarker({ coordinates }, pin);
    map.addChild(marker);
    status.textContent = 'Точка выбрана. Сохраните карточку объекта.';
  };
  if (hasPoint) setPoint([longitude, latitude]);
  map.addChild(new window.ymaps3.YMapListener({ layer: 'any', onClick: (_, event) => { if (event?.coordinates) setPoint(event.coordinates); } }));
  status.textContent = hasPoint ? 'Точка загружена. Коснитесь карты, чтобы перенести её.' : 'Коснитесь карты, чтобы поставить точку объекта.';
}
async function save(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const input = Object.fromEntries(new FormData(form));
  if (current === 'objects') {
    input.latitude = Number(input.latitude);
    input.longitude = Number(input.longitude);
    input.radius = Number(input.radius);
  }
  if (current === 'employees') input.privacy_confirmed_at = new Date().toISOString();
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    await api(`/api/cabinet/${current}${editing.id ? `/${editing.id}` : ''}`, input, editing.id ? 'PUT' : 'POST');
    await load();
  } catch (error) { button.disabled = false; document.querySelector('#form-error').innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`; }
}
load().catch(error => { token = null; sessionStorage.removeItem('cabinet-manager-token'); root.innerHTML = `<main class="loading"><h1>Не удалось открыть кабинет</h1><p>${escapeHtml(error.message)}</p><button id="retry">Повторить</button></main>`; document.querySelector('#retry').onclick = () => load().catch(() => {}); });
