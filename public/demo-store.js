(() => {
  const { WORK_TYPES, OBJECT, EMPLOYEE, GEO_CASES } = window.DEMO_CONFIG;
  const key = 'maximum-demo-browser-v1';
  const sessions = new Map();
  const read = () => {
    try { return JSON.parse(localStorage.getItem(key)) || { rooms: {} }; }
    catch { throw new Error('Не удалось прочитать сохранённый показ. Откройте демонстрацию в обычном режиме браузера.'); }
  };
  const write = value => {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch { throw new Error('Браузер не смог сохранить данные. Освободите место или откройте демонстрацию вне приватного режима.'); }
  };
  const distance = (a, b) => {
    const rad = n => n * Math.PI / 180;
    const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
    return Math.round(6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
  };
  window.demoApi = async (path, input, token) => {
    const store = read();
    let session = sessions.get(token);
    if (path === '/api/demo/session') {
      if (!['employee', 'manager'].includes(input.role)) throw new Error('Выберите роль.');
      let room = input.room;
      if (!room) {
        room = crypto.randomUUID();
        store.rooms[room] = { visit: null, report: null, attempts: [] };
        write(store);
      }
      if (!store.rooms[room]) throw new Error('Этот показ не сохранён на телефоне. Начните новый показ.');
      token = crypto.randomUUID();
      session = { room, role: input.role };
      sessions.set(token, session);
    }
    if (!session) throw new Error('Сеанс показа завершён. Обновите страницу.');
    const current = store.rooms[session.room];
    const state = () => ({ token, room: session.room, role: session.role, employee: EMPLOYEE, object: OBJECT, workTypes: WORK_TYPES, ...current, serverTime: new Date().toISOString() });
    if (path === '/api/demo/session' || path === '/api/state') return state();
    if (session.role !== 'employee') throw new Error('Это действие выполняет сотрудник.');
    if (path === '/api/arrival') {
      if (current.visit) return { accepted: true, ...state() };
      if (!['onsite', 'offsite', 'inaccurate', 'denied', 'unavailable'].includes(input.scenario)) throw new Error('Выберите тестовую ситуацию.');
      const point = GEO_CASES[input.scenario];
      const meters = point ? distance(OBJECT, point) : null;
      const accepted = Boolean(point && meters + point.accuracy <= OBJECT.radius);
      const messages = {
        denied: 'Нет доступа к геопозиции. Разрешите доступ в настройках телефона и повторите попытку.',
        unavailable: 'Не удалось получить геопозицию. Попробуйте ещё раз. Прибытие пока не отмечено.',
        inaccurate: 'Геопозиция слишком неточная. Перейдите на открытое место и повторите попытку.',
        offsite: `Вы вне объекта: расстояние ${meters} м, допустимый радиус ${OBJECT.radius} м. Отметиться можно после прибытия.`,
        onsite: 'Прибытие зафиксировано. После работы сдайте персональный отчёт.',
      };
      const message = messages[input.scenario];
      const now = new Date().toISOString();
      current.attempts.unshift({ created_at: now, outcome: accepted ? 'accepted' : input.scenario, message, distance: meters });
      current.attempts = current.attempts.slice(0, 20);
      if (accepted) current.visit = { arrived_at: now, distance: meters, accuracy: point.accuracy, employee: EMPLOYEE, object_name: OBJECT.name };
      write(store);
      return { ...state(), accepted, message };
    }
    if (path === '/api/report') {
      if (!current.visit) throw new Error('Сначала отметьте прибытие на объект.');
      if (current.report) return state();
      if (!Object.hasOwn(WORK_TYPES, input.workType) || !WORK_TYPES[input.workType].units.includes(input.unit)) throw new Error('Выберите вид работ и единицу измерения.');
      if (!Number.isFinite(input.quantity) || input.quantity <= 0 || input.quantity > 100000) throw new Error('Укажите объём больше нуля и не больше 100 000.');
      if (input.unit === 'шт.' && !Number.isInteger(input.quantity)) throw new Error('Количество в штуках должно быть целым.');
      if (typeof input.parameters !== 'string' || !input.parameters.trim() || input.parameters.length > 2000 || typeof input.comment !== 'string' || input.comment.length > 2000) throw new Error('Укажите параметры работ. Максимум 2000 символов в каждом текстовом поле.');
      current.report = { submitted_at: new Date().toISOString(), work_type: input.workType, work_label: WORK_TYPES[input.workType].label, quantity: input.quantity, unit: input.unit, parameters: input.parameters.trim(), comment: input.comment.trim(), employee: EMPLOYEE, object_name: OBJECT.name };
      write(store);
      return state();
    }
    throw new Error('Неизвестное действие.');
  };
})();
