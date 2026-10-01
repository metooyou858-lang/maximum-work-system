const root = document.querySelector('#cabinet');
const resources = {
  objects: { title: 'Мои объекты', singular: 'объект', action: 'Добавить объект', columns: [['contractor_name', 'Подрядчик'], ['address', 'Адрес объекта']], fields: [['contractor_name', 'Наименование подрядчика', 'text'], ['address', 'Адрес объекта', 'text']] },
  employees: {
    title: 'Сотрудники', singular: 'сотрудника', action: 'Добавить сотрудника',
    columns: [['full_name', 'ФИО'], ['birth_date', 'Дата рождения'], ['clothing_size', 'Одежда'], ['shoe_size', 'Обувь']],
    fields: [
      ['full_name', 'ФИО', 'text'],
      ['email', 'Личный email', 'email'],
      ['phone', 'Телефон', 'tel'],
      ['photo', 'Фотография', 'file'],
      ['birth_date', 'Дата рождения', 'date'],
      ['clothing_size', 'Размер одежды', 'select', ['40', '42', '44', '46', '48', '50', '52', '54', '56', '58', '60', '62']],
      ['shoe_size', 'Размер обуви', 'select', ['35', '36', '37', '38', '39', '40', '41', '42', '43', '44', '45', '46', '47']],
    ],
  },
  equipment: { title: 'Оборудование', singular: 'оборудование', action: 'Добавить оборудование', columns: [['name', 'Название'], ['inventory_number', 'Инвентарный номер'], ['equipment_type', 'Тип оборудования']], fields: [['name', 'Название', 'text'], ['inventory_number', 'Инвентарный номер', 'text'], ['equipment_type', 'Тип оборудования', 'text']] },
};
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
let token = sessionStorage.getItem('maximum-work-token');
let user = null;
let current = 'objects';
let items = [];
let editing = null;
let viewing = null;
let menuOpen = false;
let photoUrl = null;
let yandexMapsPromise;
let objectMap;
let objectMarker;
let radiusFeature;
let selectedAddressCoordinates;
const routeKey = 'maximum-work-route';
const apiRoot = '/manager';

function savedRoute() {
  const hash = /^#(objects|employees|equipment)\/(list|view|edit|create)(?:\/(\d+))?$/.exec(location.hash);
  if (hash) return { current: hash[1], mode: hash[2], id: hash[3] ? Number(hash[3]) : null };
  try {
    const route = JSON.parse(sessionStorage.getItem(routeKey));
    return route && resources[route.current] ? route : null;
  } catch { return null; }
}
function storeRoute() {
  const record = viewing || editing;
  const mode = viewing ? 'view' : editing?.id ? 'edit' : editing ? 'create' : 'list';
  const route = { current, mode, id: record?.id || null };
  sessionStorage.setItem(routeKey, JSON.stringify(route));
  const hash = `#${route.current}/${route.mode}${route.id ? `/${route.id}` : ''}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

async function api(path, input, method = 'POST') {
  let response;
  try {
    response = await fetch(`${apiRoot}${path}`, { method, signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  } catch { throw new Error('Не удалось связаться с сервером за 10 секунд. Проверьте, что приложение запущено, и повторите попытку.'); }
  if (response.status === 204) return null;
  let result;
  try { result = await response.json(); } catch { throw new Error('Сервер вернул некорректный ответ. Перезапустите приложение и повторите попытку.'); }
  if (!response.ok) throw new Error(result.error || 'Не удалось выполнить действие.');
  return result;
}
function loginView(message = '') {
  root.innerHTML = `<main class="login"><section><p class="eyebrow">MAXIMUM · учёт работ</p><h1>Вход в систему</h1><p>Войдите под своей учётной записью руководителя или сотрудника.</p>${message ? `<div class="error" role="alert">${escapeHtml(message)}</div>` : ''}<form id="login-form"><div class="control"><label for="login">Логин</label><input id="login" name="login" autocomplete="username" maxlength="64" required></div><div class="control"><label for="password">Пароль</label><input id="password" name="password" type="password" autocomplete="current-password" required></div><button class="primary" type="submit">Войти</button></form><p class="note">В тестовой среде используются только синтетические данные.</p></section></main>`;
  document.querySelector('#login-form').onsubmit = submitLogin;
}
async function submitLogin(event) {
  event.preventDefault();
  const form = event.currentTarget; const button = form.querySelector('button'); button.disabled = true;
  try {
    const result = await api('/api/auth/login', Object.fromEntries(new FormData(form)));
    token = result.token; user = result.user; sessionStorage.setItem('maximum-work-token', token);
    if (user.role !== 'manager') throw new Error('Рабочий кабинет сейчас доступен только руководителю.');
    await load(true);
  } catch (error) { token = null; user = null; sessionStorage.removeItem('maximum-work-token'); loginView(error.message); }
}
async function restore() {
  if (!token) return loginView();
  try {
    const session = await api('/api/auth/session', undefined, 'GET'); user = session.user;
    if (user.role !== 'manager') throw new Error('Рабочий кабинет сейчас доступен только руководителю.');
    await load(true);
  } catch { token = null; sessionStorage.removeItem('maximum-work-token'); loginView('Сеанс завершён. Войдите снова.'); }
}
function nav() {
  return `<aside class="sidebar ${menuOpen ? 'open' : ''}" aria-label="Основные разделы"><div class="sidebar-head"><span>Учёт работ</span><button class="close-menu" id="close-menu" aria-label="Закрыть меню">×</button></div><nav>${Object.entries(resources).map(([key, resource]) => `<button class="nav-item ${key === current ? 'active' : ''}" data-section="${key}" aria-current="${key === current ? 'page' : 'false'}">${resource.title}</button>`).join('')}</nav><div class="sidebar-foot"><p>${escapeHtml(user.login)}</p><button id="logout">Выйти</button><p class="sidebar-note">Только синтетические данные.</p></div></aside>`;
}
function format(field, value) {
  if (field === 'birth_date' && value) return new Date(`${value}T00:00:00`).toLocaleDateString('ru-RU');
  if (field === 'phone') return phoneMask(value);
  return value;
}
function phoneMask(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('8')) digits = `7${digits.slice(1)}`;
  if (digits && !digits.startsWith('7')) digits = `7${digits}`;
  digits = digits.slice(0, 11);
  if (!digits) return '';
  if (digits.length === 1) return '+7';
  let result = `+7 (${digits.slice(1, 4)}`;
  if (digits.length >= 4) result += ')';
  if (digits.length > 4) result += ` ${digits.slice(4, 7)}`;
  if (digits.length > 7) result += `-${digits.slice(7, 9)}`;
  if (digits.length > 9) result += `-${digits.slice(9, 11)}`;
  return result;
}
function initials(value) { return String(value || '').split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join('').toUpperCase() || '—'; }
function clearPhotoUrl() { if (photoUrl) URL.revokeObjectURL(photoUrl); photoUrl = null; }
async function showEmployeePhoto(employee) {
  clearPhotoUrl();
  const image = document.querySelector('#employee-photo');
  const fallback = document.querySelector('#employee-initials');
  if (!image || !employee.photo_file) return;
  try {
    const response = await fetch(`${apiRoot}/api/manager/employees/${employee.id}/photo`, { signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return;
    photoUrl = URL.createObjectURL(await response.blob());
    image.src = photoUrl; image.hidden = false; fallback.hidden = true;
  } catch { /* Карточка остаётся с инициалами, если фотография временно недоступна. */ }
}
function list() {
  const resource = resources[current];
  const emptyText = current === 'employees' ? 'Добавьте карточку сотрудника. Для него будет создана серверная связь с будущей учётной записью; отправка приглашений пока отключена.' : 'Создайте первую запись — она появится в общем списке.';
  return `<section class="page"><header class="page-head"><div><h1>${resource.title}</h1><p>${items.length ? `Записей: ${items.length}` : 'Записей пока нет'}</p></div><button class="primary" id="create">${resource.action}</button></header>${items.length ? `<div class="table-wrap"><table><thead><tr>${resource.columns.map(([, label]) => `<th>${label}</th>`).join('')}<th aria-label="Открыть карточку"></th></tr></thead><tbody>${items.map(item => `<tr data-record="${item.id}" tabindex="0">${resource.columns.map(([field]) => `<td>${escapeHtml(format(field, item[field]))}</td>`).join('')}<td class="open-mark" aria-hidden="true">›</td></tr>`).join('')}</tbody></table></div>` : `<section class="empty-state"><h2>Здесь пока пусто</h2><p>${emptyText}</p></section>`}</section>`;
}
function editor() {
  const resource = resources[current]; const item = editing || {};
  const title = item.id ? `Карточка: ${item.full_name || item.name || item.address}` : resource.action;
  const field = ([name, label, type, options]) => {
    const value = name === 'phone' ? phoneMask(item[name]) : item[name] || '';
    if (type === 'file') return `<div class="control"><label for="${name}">${label}</label><input id="${name}" type="file" accept="image/jpeg,image/png,image/webp"><p class="field-note">JPG, PNG или WebP до 5 МБ${item.photo_file ? '. Фотография уже загружена' : ''}.</p></div>`;
    if (type !== 'select') {
      const hint = name === 'email' ? ' autocomplete="email" placeholder="name@example.ru"' : name === 'phone' ? ' autocomplete="tel" inputmode="tel" placeholder="+7 (999) 999-99-99" pattern="\\+7 \\(\\d{3}\\) \\d{3}-\\d{2}-\\d{2}"' : '';
      if (current === 'objects' && name === 'address') return `<div class="control address-control-wrap"><label for="address">Адрес объекта</label><div class="address-control"><input id="address" name="address" type="text" maxlength="200" required autocomplete="off" placeholder="Например: Хабаровск, улица Ленина, 1" value="${escapeHtml(value)}"><div id="address-suggestions" class="address-suggestions" role="listbox" aria-label="Подсказки адресов" hidden></div></div><p class="field-note">Начните вводить адрес и выберите вариант из подсказок Яндекса.</p></div>`;
      return `<div class="control"><label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" maxlength="200" required${hint} value="${escapeHtml(value)}"></div>`;
    }
    return `<div class="control"><label for="${name}">${label}</label><select id="${name}" name="${name}" required><option value="" disabled ${value ? '' : 'selected'}>Выберите размер</option>${options.map(option => `<option value="${option}" ${option === value ? 'selected' : ''}>${option}</option>`).join('')}</select></div>`;
  };
  const objectLocation = current === 'objects' ? `<section class="object-location" aria-labelledby="map-title"><h2 id="map-title">Подтверждение адреса на карте</h2><p>Проверьте введённый адрес. Сохранить можно только адрес, который подтвердил Яндекс.</p><div id="object-map-status" class="map-status" role="status">Подключаем карту…</div><div id="object-map" class="object-map" aria-label="Карта для подтверждения адреса объекта"></div><input id="latitude" name="latitude" type="hidden" value="${escapeHtml(item.latitude ?? '')}"><input id="longitude" name="longitude" type="hidden" value="${escapeHtml(item.longitude ?? '')}"><input id="address-confirmed" name="address_confirmed" type="hidden" value="${item.address_verified ? 'true' : ''}"><p id="object-point" class="map-point">${item.latitude !== undefined && item.latitude !== null && item.longitude !== undefined && item.longitude !== null ? `Точка: ${Number(item.latitude).toFixed(6)}, ${Number(item.longitude).toFixed(6)}` : 'Адрес пока не подтверждён.'}</p><div class="control"><label for="radius">Радиус объекта, м</label><input id="radius" name="radius" type="number" inputmode="numeric" min="10" max="5000" step="1" required value="${escapeHtml(item.radius ?? 150)}"></div></section>` : '';
  return `<section class="page form-page"><header class="page-head"><div><button class="back" id="cancel">← К списку</button><h1>${escapeHtml(title)}</h1></div></header><form id="record-form">${resource.fields.map(field).join('')}${objectLocation}${current === 'employees' ? `<section class="privacy"><h2>Персональные данные и доступ</h2><p>Личный email нужен для будущего приглашения. При создании карточки система связывает сотрудника с отдельной будущей учётной записью; в тестовой среде приглашение не отправляется. Версия политики: «Тестовая политика 1.0».</p><label class="check"><input id="privacy-confirmed" type="checkbox" ${item.privacy_confirmed_at ? 'checked' : ''} required> Подтверждение ознакомления с политикой зафиксировано</label></section>` : ''}<div id="form-error" role="alert"></div><div class="form-actions"><button type="button" id="cancel-bottom">Отменить</button><button class="primary" type="submit">${item.id ? 'Сохранить изменения' : 'Создать карточку'}</button></div></form></section>`;
}

function loadYandexMaps(scriptUrl) {
  if (window.ymaps3) return Promise.resolve();
  if (!yandexMapsPromise) yandexMapsPromise = new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = scriptUrl; script.onload = resolve; script.onerror = () => reject(new Error('Не удалось загрузить Яндекс Карты.')); document.head.appendChild(script); });
  return yandexMapsPromise;
}
async function initializeObjectMap() {
  const rootMap = document.querySelector('#object-map'); const status = document.querySelector('#object-map-status');
  if (!rootMap || !status) return;
  const config = await api('/api/manager/map-config', undefined, 'GET');
  if (!config.enabled) throw new Error('Ключ Яндекс Карт не настроен на сервере.');
  await loadYandexMaps(config.scriptUrl);
  await window.ymaps3.ready;
  const latitudeValue = document.querySelector('#latitude').value; const longitudeValue = document.querySelector('#longitude').value; const latitude = Number(latitudeValue); const longitude = Number(longitudeValue); const hasPoint = latitudeValue !== '' && longitudeValue !== '' && Number.isFinite(latitude) && Number.isFinite(longitude);
  const map = new window.ymaps3.YMap(rootMap, { location: { center: hasPoint ? [longitude, latitude] : [135.0721, 48.4827], zoom: hasPoint ? 16 : 11 } });
  map.addChild(new window.ymaps3.YMapDefaultSchemeLayer({})); map.addChild(new window.ymaps3.YMapDefaultFeaturesLayer({ zIndex: 1800 }));
  const circleGeometry = (center, radius) => { const [longitude, latitude] = center; const earthRadius = 6378137; const angular = radius / earthRadius; const latitudeRad = latitude * Math.PI / 180; const longitudeRad = longitude * Math.PI / 180; const segments = 128; const points = []; for (let index = 0; index <= segments; index += 1) { const bearing = index * 2 * Math.PI / segments; const pointLatitude = Math.asin(Math.sin(latitudeRad) * Math.cos(angular) + Math.cos(latitudeRad) * Math.sin(angular) * Math.cos(bearing)); const pointLongitude = longitudeRad + Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(latitudeRad), Math.cos(angular) - Math.sin(latitudeRad) * Math.sin(pointLatitude)); points.push([pointLongitude * 180 / Math.PI, pointLatitude * 180 / Math.PI]); } return { type: 'Polygon', coordinates: [points] }; };
  const updateRadius = coordinates => { const radius = Number(document.querySelector('#radius')?.value); if (!Number.isFinite(radius) || radius < 10) return; const geometry = circleGeometry(coordinates, radius); if (radiusFeature) radiusFeature.update({ geometry }); else { radiusFeature = new window.ymaps3.YMapFeature({ geometry, style: { simplificationRate: 0, fill: 'rgba(28, 117, 188, 0.14)', stroke: [{ color: '#1c75bc', width: 2 }] } }); map.addChild(radiusFeature); } };
  const setPoint = (coordinates, confirmed = false) => { document.querySelector('#longitude').value = coordinates[0]; document.querySelector('#latitude').value = coordinates[1]; document.querySelector('#address-confirmed').value = confirmed ? 'true' : ''; document.querySelector('#object-point').textContent = confirmed ? `Адрес подтверждён: ${coordinates[1].toFixed(6)}, ${coordinates[0].toFixed(6)}` : 'Адрес нужно подтвердить через поиск Яндекса.'; if (objectMarker) map.removeChild(objectMarker); const pin = document.createElement('div'); pin.className = 'map-pin'; objectMarker = new window.ymaps3.YMapMarker({ coordinates }, pin); map.addChild(objectMarker); updateRadius(coordinates); status.textContent = confirmed ? 'Адрес найден и подтверждён. Сохраните карточку объекта.' : 'Точка изменена. Выберите адрес через поиск Яндекса.'; };
  if (hasPoint) setPoint([longitude, latitude], document.querySelector('#address-confirmed').value === 'true');
  document.querySelector('#radius').addEventListener('input', () => { const latitudeValue = Number(document.querySelector('#latitude').value); const longitudeValue = Number(document.querySelector('#longitude').value); if (Number.isFinite(latitudeValue) && Number.isFinite(longitudeValue)) updateRadius([longitudeValue, latitudeValue]); });
  const addressInput = document.querySelector('#address'); const suggestions = document.querySelector('#address-suggestions'); let suggestionTimer; let suggestionRequest = 0; let addressSelectionLocked = Boolean(document.querySelector('#address-confirmed').value);
  const closeSuggestions = () => { suggestions.replaceChildren(); suggestions.hidden = true; };
  const chooseAddress = result => { const coordinates = [Number(result.longitude), Number(result.latitude)]; selectedAddressCoordinates = coordinates; addressSelectionLocked = true; addressInput.value = result.address; closeSuggestions(); map.update({ location: { center: coordinates, zoom: 16, duration: 400 } }); setPoint(coordinates, true); const confirm = () => { document.querySelector('#longitude').value = String(coordinates[0]); document.querySelector('#latitude').value = String(coordinates[1]); document.querySelector('#address-confirmed').value = 'true'; }; confirm(); setTimeout(confirm, 100); };
  const loadSuggestions = async query => { const request = ++suggestionRequest; status.textContent = 'Ищем адреса через Яндекс…'; try { const results = await api(`/api/manager/geocode?q=${encodeURIComponent(query)}`, undefined, 'GET'); if (request !== suggestionRequest) return; suggestions.replaceChildren(); results.slice(0, 5).forEach(result => { const option = document.createElement('button'); option.type = 'button'; option.className = 'address-suggestion'; option.setAttribute('role', 'option'); option.textContent = result.address; option.onclick = () => chooseAddress(result); suggestions.appendChild(option); }); suggestions.hidden = results.length === 0; status.textContent = results.length ? 'Выберите адрес из подсказок Яндекса.' : 'Яндекс не нашёл подходящий адрес.'; } catch (error) { if (request === suggestionRequest) { closeSuggestions(); status.textContent = error.message; } } };
  addressInput.addEventListener('input', () => { selectedAddressCoordinates = null; addressSelectionLocked = false; document.querySelector('#address-confirmed').value = ''; closeSuggestions(); suggestionRequest += 1; const query = addressInput.value.trim(); status.textContent = query.length >= 3 ? 'Подбираем варианты адреса…' : 'Введите минимум 3 символа адреса.'; clearTimeout(suggestionTimer); if (query.length >= 3) suggestionTimer = setTimeout(() => loadSuggestions(query), 450); });
  addressInput.addEventListener('focus', () => { if (suggestions.childElementCount) suggestions.hidden = false; });
  addressInput.addEventListener('blur', () => setTimeout(closeSuggestions, 150));
  map.addChild(new window.ymaps3.YMapListener({ layer: 'any', onClick: (_, event) => { if (event?.coordinates && !addressSelectionLocked) setPoint(event.coordinates); } }));
  status.textContent = hasPoint ? 'Точка загружена. Коснитесь карты, чтобы перенести её.' : 'Коснитесь карты, чтобы поставить точку объекта.'; objectMap = map;
}
function details() {
  const resource = resources[current]; const item = viewing;
  if (current === 'employees') {
    const personalField = (name, label, wide = false) => `<div class="employee-field ${wide ? 'wide' : ''}"><dt>${label}</dt><dd>${escapeHtml(format(name, item[name]) || 'Не указано')}</dd></div>`;
    const sizeField = (name, label) => `<div class="employee-size"><dt>${label}</dt><dd>${escapeHtml(item[name] || '—')}</dd></div>`;
    return `<section class="page employee-detail-page"><article class="employee-card"><header class="employee-card-head"><div class="employee-photo"><span id="employee-initials">${initials(item.full_name)}</span><img id="employee-photo" alt="Фотография сотрудника" hidden></div><div class="employee-card-identity"><p class="employee-card-kicker">Карточка сотрудника</p><h1>${escapeHtml(item.full_name)}</h1></div></header><div class="employee-card-body"><section class="employee-section"><div class="employee-section-heading"><h2>Личные данные</h2><p>4 поля</p></div><dl class="employee-field-grid">${personalField('full_name', 'ФИО', true)}${personalField('email', 'Личный email')}${personalField('phone', 'Телефон')}${personalField('birth_date', 'Дата рождения')}</dl></section><section class="employee-section"><div class="employee-section-heading"><h2>Размеры</h2><p>для экипировки</p></div><dl class="employee-size-grid">${sizeField('clothing_size', 'Размер одежды')}${sizeField('shoe_size', 'Размер обуви')}</dl></section><div class="employee-card-actions"><button class="primary" id="edit">Редактировать данные</button></div></div></article></section>`;
  }
  const visibleFields = resource.fields.filter(([, , type]) => type !== 'file');
  const heading = `<div><button class="back" id="back-list">← К списку</button><h1>${escapeHtml(item.full_name || item.name || item.address)}</h1></div>`;
  return `<section class="page detail-page"><header class="page-head detail-head">${heading}<button class="primary" id="edit">Редактировать</button></header><dl class="record-details">${visibleFields.map(([name, label]) => `<div><dt>${label}</dt><dd>${escapeHtml(format(name, item[name]))}</dd></div>`).join('')}</dl></section>`;
}
function render(message = '') {
  storeRoute();
  root.innerHTML = `<div class="shell">${nav()}<div class="scrim ${menuOpen ? 'visible' : ''}" id="scrim"></div><main class="content"><header class="mobile-head"><button id="open-menu" aria-label="Открыть меню">Меню</button><span>${resources[current].title}</span></header>${message ? `<div class="error" role="alert">${escapeHtml(message)}</div>` : ''}${viewing ? details() : editing === null ? list() : editor()}</main></div>`;
  document.querySelectorAll('[data-section]').forEach(button => button.onclick = async () => { current = button.dataset.section; editing = null; viewing = null; menuOpen = false; try { await load(); } catch (error) { render(error.message); } });
  document.querySelector('#open-menu')?.addEventListener('click', () => { menuOpen = true; render(); });
  document.querySelector('#close-menu')?.addEventListener('click', () => { menuOpen = false; render(); });
  document.querySelector('#scrim')?.addEventListener('click', () => { menuOpen = false; render(); });
  document.querySelector('#logout').onclick = async () => { try { await api('/api/auth/logout', {}, 'POST'); } finally { token = null; user = null; sessionStorage.removeItem('maximum-work-token'); sessionStorage.removeItem(routeKey); history.replaceState(null, '', location.pathname); loginView(); } };
  document.querySelector('#create')?.addEventListener('click', () => { viewing = null; editing = {}; render(); });
  document.querySelectorAll('[data-record]').forEach(row => { const open = () => { viewing = items.find(item => item.id === Number(row.dataset.record)); editing = null; render(); }; row.onclick = open; row.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } }; });
  document.querySelector('#back-list')?.addEventListener('click', () => { viewing = null; render(); });
  document.querySelector('#edit')?.addEventListener('click', () => { editing = viewing; viewing = null; render(); });
  document.querySelector('#cancel')?.addEventListener('click', () => { editing = null; render(); });
  document.querySelector('#cancel-bottom')?.addEventListener('click', () => { editing = null; render(); });
  document.querySelector('#record-form')?.addEventListener('submit', save);
  document.querySelector('#phone')?.addEventListener('input', event => { event.currentTarget.value = phoneMask(event.currentTarget.value); });
  if (viewing?.photo_file && current === 'employees') showEmployeePhoto(viewing);
  else clearPhotoUrl();
  if (editing !== null && current === 'objects') initializeObjectMap().catch(error => { const status = document.querySelector('#object-map-status'); if (status) status.textContent = error.message; });
}
async function load(restoreRoute = false) {
  const route = restoreRoute ? savedRoute() : null;
  if (route) current = route.current;
  items = await api(`/api/manager/${current}`, undefined, 'GET'); editing = null; viewing = null;
  const record = route?.id ? items.find(item => item.id === route.id) : null;
  if (route?.mode === 'view' && record) viewing = record;
  if (route?.mode === 'edit' && record) editing = record;
  if (route?.mode === 'create') editing = {};
  render();
}
async function save(event) {
  event.preventDefault(); const form = event.currentTarget; if (!form.reportValidity()) return;
  const input = Object.fromEntries(new FormData(form)); if (current === 'objects') { if (selectedAddressCoordinates) { input.longitude = String(selectedAddressCoordinates[0]); input.latitude = String(selectedAddressCoordinates[1]); input.address_confirmed = 'true'; } input.latitude = Number(input.latitude); input.longitude = Number(input.longitude); input.radius = Number(input.radius); input.address_verified = input.address_confirmed === 'true'; delete input.address_confirmed; } if (current === 'employees') input.privacy_confirmed_at = new Date().toISOString();
  const button = form.querySelector('[type="submit"]'); button.disabled = true;
  try {
    const photo = form.querySelector('#photo')?.files[0];
    if (photo) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(photo.type) || photo.size > 5 * 1024 * 1024) throw new Error('Загрузите JPG, PNG или WebP размером до 5 МБ.');
      const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(photo); });
      input.photo_data = { type: photo.type, base64 };
    }
    const isEdit = Boolean(editing.id);
    const saved = await api(`/api/manager/${current}${isEdit ? `/${editing.id}` : ''}`, input, isEdit ? 'PUT' : 'POST');
    if (isEdit) { items = items.map(item => item.id === saved.id ? saved : item); editing = null; viewing = saved; render(); }
    else await load();
  }
  catch (error) { button.disabled = false; document.querySelector('#form-error').innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`; }
}
restore();
