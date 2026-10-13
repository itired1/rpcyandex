'use strict';

/**
 * Declarative description of every user-facing setting.
 *
 * The settings window renders itself from this list, so adding a setting means
 * adding one entry here rather than hand-writing a control. It also makes the
 * form verifiable: the test suite asserts that every path below exists in
 * DEFAULT_SETTINGS, and that every setting is either described or explicitly
 * listed as internal.
 */

/** Field kinds the renderer knows how to draw. */
const FIELD_TYPES = {
  BOOLEAN: 'boolean',
  TEXT: 'text',
  SECRET: 'secret',
  NUMBER: 'number',
  SELECT: 'select',
  HOTKEY: 'hotkey',
  DIRECTORY: 'directory',
  READONLY: 'readonly',
  ACTION: 'action',
};

const SECTIONS = [
  {
    id: 'discord',
    title: 'Discord Rich Presence',
    description:
      'Статус в Discord с названием трека, исполнителем, обложкой и прогрессом.',
    fields: [
      { path: 'discord.enabled', type: FIELD_TYPES.BOOLEAN, label: 'Включить Rich Presence' },
      {
        path: 'discord.clientId',
        type: FIELD_TYPES.TEXT,
        label: 'Application ID',
        placeholder: 'например 1479783995435647107',
        help:
          'Создайте приложение на discord.com/developers/applications и скопируйте ' +
          'Application ID. Это не секрет, его можно публиковать.',
      },
      {
        path: 'discord.displayType',
        type: FIELD_TYPES.SELECT,
        label: 'Что показывать',
        options: [
          { value: 'details', label: 'Трек и исполнитель с альбомом' },
          { value: 'album', label: 'Трек и альбом' },
          { value: 'minimal', label: 'Только трек' },
        ],
      },
      {
        path: 'discord.language',
        type: FIELD_TYPES.SELECT,
        label: 'Язык статуса',
        options: [
          { value: 'auto', label: 'Как в клиенте' },
          { value: 'ru', label: 'Русский' },
          { value: 'en', label: 'English' },
        ],
      },
      { path: 'discord.showTimestamps', type: FIELD_TYPES.BOOLEAN, label: 'Показывать прогресс' },
      { path: 'discord.showButtons', type: FIELD_TYPES.BOOLEAN, label: 'Кнопка «Найти трек»' },
      {
        path: 'discord.smallImageKey',
        type: FIELD_TYPES.TEXT,
        label: 'Ключ маленькой иконки',
        placeholder: 'оставьте пустым, если не загружали',
        help: 'Работает только если такой ассет загружен в ваше Discord-приложение.',
      },
      {
        path: 'discord.idleTimeoutMinutes',
        type: FIELD_TYPES.NUMBER,
        label: 'Сбрасывать статус после паузы, мин',
        min: 0,
        max: 240,
        help: '0 — не сбрасывать.',
      },
      {
        path: 'discord.reconnectIntervalSeconds',
        type: FIELD_TYPES.NUMBER,
        label: 'Интервал переподключения, сек',
        min: 5,
        max: 600,
      },
      {
        path: 'discord.statusDisplayType',
        type: FIELD_TYPES.SELECT,
        label: 'Строка рядом с названием приложения',
        options: [
          { value: 0, label: 'Название приложения' },
          { value: 1, label: 'Первая строка' },
          { value: 2, label: 'Вторая строка' },
        ],
      },
    ],
  },
  {
    id: 'lastfm',
    title: 'Last.fm',
    description:
      'Скробблинг прослушанного. Трек засчитывается после половины длительности, ' +
      'но не более четырёх минут, и не короче 30 секунд.',
    fields: [
      { path: 'lastfm.enabled', type: FIELD_TYPES.BOOLEAN, label: 'Включить скробблинг' },
      {
        path: 'lastfm.apiKey',
        type: FIELD_TYPES.SECRET,
        label: 'API key',
        help: 'Зарегистрируйте приложение на last.fm/api/account/create.',
      },
      {
        path: 'lastfm.sharedSecret',
        type: FIELD_TYPES.SECRET,
        label: 'Shared secret',
        help: 'Ключи хранятся в открытом виде в config.json, как и у клиента.',
      },
      {
        path: 'lastfm.scrobbleThresholdPercent',
        type: FIELD_TYPES.NUMBER,
        label: 'Порог прослушивания, %',
        min: 1,
        max: 100,
      },
      { type: FIELD_TYPES.READONLY, label: 'Состояние', source: 'lastfmStatus' },
      { type: FIELD_TYPES.ACTION, label: 'Учётная запись', source: 'lastfmAccount' },
    ],
  },
  {
    id: 'hotkeys',
    title: 'Горячие клавиши',
    description:
      'Работают, когда клиент свёрнут. Если комбинацию заняла другая программа, ' +
      'это будет видно рядом с полем.',
    fields: [
      { path: 'hotkeys.enabled', type: FIELD_TYPES.BOOLEAN, label: 'Включить хоткеи' },
      { path: 'hotkeys.playPause', type: FIELD_TYPES.HOTKEY, label: 'Играть / пауза' },
      { path: 'hotkeys.next', type: FIELD_TYPES.HOTKEY, label: 'Следующий трек' },
      { path: 'hotkeys.previous', type: FIELD_TYPES.HOTKEY, label: 'Предыдущий трек' },
      { path: 'hotkeys.volumeUp', type: FIELD_TYPES.HOTKEY, label: 'Громче' },
      { path: 'hotkeys.volumeDown', type: FIELD_TYPES.HOTKEY, label: 'Тише' },
      { path: 'hotkeys.miniPlayer', type: FIELD_TYPES.HOTKEY, label: 'Мини-плеер' },
      { path: 'hotkeys.settings', type: FIELD_TYPES.HOTKEY, label: 'Настройки' },
      { path: 'hotkeys.zoomIn', type: FIELD_TYPES.HOTKEY, label: 'Масштаб: крупнее' },
      { path: 'hotkeys.zoomOut', type: FIELD_TYPES.HOTKEY, label: 'Масштаб: мельче' },
      { path: 'hotkeys.zoomReset', type: FIELD_TYPES.HOTKEY, label: 'Масштаб: сброс' },
    ],
  },
  {
    id: 'miniplayer',
    title: 'Мини-плеер',
    description: 'Отдельное окно с текущим треком поверх остальных.',
    fields: [
      { path: 'miniplayer.enabled', type: FIELD_TYPES.BOOLEAN, label: 'Разрешить мини-плеер' },
      { path: 'miniplayer.alwaysOnTop', type: FIELD_TYPES.BOOLEAN, label: 'Поверх других окон' },
      { path: 'miniplayer.openOnStart', type: FIELD_TYPES.BOOLEAN, label: 'Открывать при запуске' },
      { path: 'ui.showCodec', type: FIELD_TYPES.BOOLEAN, label: 'Показывать кодек и битрейт' },
      { type: FIELD_TYPES.ACTION, label: 'Открыть мини-плеер', source: 'miniPlayerOpen' },
    ],
  },
  {
    id: 'appearance',
    title: 'Внешний вид',
    fields: [
      {
        path: 'ui.zoom',
        type: FIELD_TYPES.NUMBER,
        label: 'Масштаб интерфейса',
        min: 0.5,
        max: 3,
        step: 0.05,
        help: 'Применяется сразу. Хоткеи Ctrl+=, Ctrl+- и Ctrl+0 делают то же самое.',
      },
      { path: 'ui.trayIcon', type: FIELD_TYPES.BOOLEAN, label: 'Значок itirpc в трее' },
      { type: FIELD_TYPES.ACTION, label: 'Служебные папки', source: 'folders' },
    ],
  },
  {
    id: 'storage',
    title: 'Файлы и кеш',
    fields: [
      {
        path: 'cache.directory',
        type: FIELD_TYPES.READONLY,
        label: 'Папка кеша',
        help:
          'Пока не изменяется: клиент хранит офлайн-репозиторий по своему усмотрению, ' +
          'и переносить его без понимания формата рискованно.',
      },
      {
        path: 'downloads.enabled',
        type: FIELD_TYPES.BOOLEAN,
        label: 'Скачивание треков (отключено намеренно)',
        help:
          'Поток клиента зашифрован: сохранённый файл не открывается ни одним плеером. ' +
          'Сделать его играбельным можно только обойдя защиту контента, чего мод не делает.',
      },
      { path: 'downloads.directory', type: FIELD_TYPES.DIRECTORY, label: 'Папка загрузок' },
      { path: 'downloads.convertToMp3', type: FIELD_TYPES.BOOLEAN, label: 'Конвертировать в MP3 (нужен ffmpeg)' },
      { path: 'downloads.ffmpegPath', type: FIELD_TYPES.TEXT, label: 'Путь к ffmpeg', placeholder: 'оставьте пустым для поиска в PATH' },
    ],
  },
  {
    id: 'advanced',
    title: 'Дополнительно',
    fields: [
      {
        path: 'debug.logLevel',
        type: FIELD_TYPES.SELECT,
        label: 'Подробность лога',
        options: [
          { value: 'error', label: 'Только ошибки' },
          { value: 'warn', label: 'Предупреждения' },
          { value: 'info', label: 'Обычный' },
          { value: 'debug', label: 'Подробный' },
        ],
      },
      {
        path: 'debug.dumpPlayerState',
        type: FIELD_TYPES.BOOLEAN,
        label: 'Писать состояние плеера в лог',
        help: 'Помогает при разборе проблем, заметно увеличивает размер лога.',
      },
      {
        path: 'debug.command',
        type: FIELD_TYPES.TEXT,
        label: 'Отладочная команда',
        placeholder: 'dump-state, toggle-play, next-track, miniplayer-toggle, zoom-reset',
        help:
          'Выполняется один раз при изменении значения. Нужна для автоматизации: ' +
          'в GUI нельзя нажать пункт трея из скрипта.',
      },
    ],
  },
];

/**
 * Settings that exist for the mod's own bookkeeping and are deliberately not
 * shown: the Last.fm session key is a credential written by the auth flow, the
 * mini player geometry is remembered from the window itself.
 */
const INTERNAL_PATHS = [
  'lastfm.sessionKey',
  'lastfm.username',
  'miniplayer.width',
  'miniplayer.height',
  'miniplayer.x',
  'miniplayer.y',
];

/** Every setting the panel shows, including read-only ones. */
function describedPaths(sections = SECTIONS) {
  const out = [];
  for (const section of sections) {
    for (const field of section.fields) {
      if (field.path) out.push(field.path);
    }
  }
  return out;
}

/**
 * Settings the panel may actually write.
 *
 * Read-only fields are shown but deliberately excluded: `cache.directory` is
 * presented as a placeholder, and letting the form write it would imply a
 * feature that does not exist.
 */
function editablePaths(sections = SECTIONS) {
  const out = [];
  for (const section of sections) {
    for (const field of section.fields) {
      if (field.path && field.type !== FIELD_TYPES.READONLY) out.push(field.path);
    }
  }
  return out;
}

/** Paths the panel displays but refuses to write. */
function readOnlyPaths(sections = SECTIONS) {
  return describedPaths(sections).filter((path) => !editablePaths(sections).includes(path));
}

module.exports = { SECTIONS, FIELD_TYPES, INTERNAL_PATHS, describedPaths, editablePaths, readOnlyPaths };

// Also expose to the settings window, which loads this file with a <script> tag.
if (typeof window !== 'undefined') {
  window.itirpcSchema = { SECTIONS, FIELD_TYPES, INTERNAL_PATHS, describedPaths, editablePaths, readOnlyPaths };
}
