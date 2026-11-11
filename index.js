// Preset Stamp — 답(스와이프)마다 어떤 모델 · 프리셋으로 만들었는지 그 메시지에 도장처럼 적어 둠.
// 기록: message.extra.preset_stamp 와 swipe_info[n].extra.preset_stamp (실리태번이 스와이프를 오갈 때 extra 를 같이 옮김)
//   { model, api, preset, profile?, context?, instruct?, sysprompt?, at, via }
//   via: 'gen' 생성 시작 때 · 'cut' /cut → /sendas 로 옮긴 답(원래 도장 이어받음) · 'quiet' /gen → /sendas
// 스와이프 · 이어 쓰기가 오류로 끊겨 「답 받음」 신호가 없을 때도 생성이 끝난 뒤 찍음, 새 스와이프는 물려받은 도장을 뗌
// 생성 중에 채팅을 옮겨 답이 나중에(다른 확장이 대신 받아) 붙어도, 채팅마다 기억한 시작 도장을 생성 시각으로 짝지어 찍음
// 메시지를 지우면 도장도 같이 사라지고, 분기 채팅에도 따라감 — 따로 정리할 것이 없음.

import { getGeneratingModel, getGeneratingApi, main_api, saveChatDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { power_user } from '../../../power-user.js';

const MODULE = 'presetStamp';
const KEY = 'preset_stamp';
// 알림에 보일 것 (설정에서 켜고 끔)
const SHOW_DEFAULTS = Object.freeze({ model: true, api: false, profile: true, preset: true, templates: true, time: false });
const FALLBACK_DELAY_MS = 1500;        // 생성이 끝난 뒤 「답 받음」 신호가 없었는지 확인할 때까지
const QUIET_TTL_MS = 10 * 60 * 1000;   // /gen 이 오래 걸려도 뒤따르는 /sendas 가 받을 수 있게
const REMOVED_TTL_MS = 60 * 1000;      // /cut 바로 뒤 /sendas 만 짝지음
const LATE_TTL_MS = 30 * 60 * 1000;    // 채팅을 옮긴 뒤 늦게 붙는 답을 기다리는 시간
const LATE_MATCH_MS = 5 * 60 * 1000;   // 늦게 붙은 답의 생성 시작 시각이 이 도장 시작에서 이만큼 안이면 같은 생성
const REAPPLY_MS = 5000;               // /sendas at= 처럼 신호 뒤 채팅을 다시 읽으면 그 안에 도장을 다시 붙임
const SLASH_MODEL = 'slash command';   // 실리태번이 /sendas 메시지에 적는 모델 이름
const ctx = () => SillyTavern.getContext();

let pendingGen = null;    // 보통 생성이 시작될 때 찍어 둔 도장 { stamp, type, at, before }
let pendingQuiet = null;  // quiet 생성(/gen)이 시작될 때 찍어 둔 도장 { stamp, at }
let snapshot = [];        // 메시지 목록 사본(참조만) — /cut 으로 지워진 메시지를 알아내려고
let removed = [];         // 최근 지워진 AI 메시지 { msg, at }
const lateByChat = new Map();   // 채팅 id → 그 채팅에서 시작한 생성 도장들 [{ stamp, at }] (채팅을 옮겨도 남김)
let reapply = null;       // 방금 찍은 /sendas 메시지 { send_date, mes, stamp, at } — 채팅을 다시 읽으면 다시 붙임

function settings() {
    if (!extension_settings[MODULE] || typeof extension_settings[MODULE] !== 'object') extension_settings[MODULE] = {};
    const s = extension_settings[MODULE];
    if (!s.show || typeof s.show !== 'object') s.show = {};
    for (const [k, v] of Object.entries(SHOW_DEFAULTS)) if (typeof s.show[k] !== 'boolean') s.show[k] = v;
    return s;
}

const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------- 도장 만들기 ----------------

function profileName() {
    const cm = extension_settings.connectionManager;
    const id = cm?.selectedProfile;
    return id ? (cm.profiles?.find(p => p.id === id)?.name || null) : null;
}

/** 지금 설정으로 도장 하나 */
function makeStamp(via) {
    const stamp = { model: '', api: '', preset: null, at: Date.now(), via };
    try { stamp.model = getGeneratingModel() || ''; } catch { /* 연결 전 */ }
    try { stamp.api = getGeneratingApi() || ''; } catch { /* 연결 전 */ }
    try { stamp.preset = ctx().getPresetManager()?.getSelectedPresetName() || null; } catch { /* 프리셋 칸 없음 */ }
    const profile = profileName();
    if (profile) stamp.profile = profile;
    if (main_api === 'textgenerationwebui') {
        stamp.context = power_user.context?.preset || null;
        stamp.instruct = power_user.instruct?.enabled ? (power_user.instruct.preset || null) : false;
        stamp.sysprompt = power_user.sysprompt?.enabled ? (power_user.sysprompt.name || null) : false;
    }
    return stamp;
}

/** 지금 보이는 판(스와이프)의 데이터 */
function activeData(message) {
    const info = Array.isArray(message.swipe_info) ? message.swipe_info[message.swipe_id ?? 0] : null;
    return info?.extra ? info : message;
}

/** 생성 시작 시각(ms) — 없으면 0 */
function startedAt(message) {
    const t = message?.gen_started ? new Date(message.gen_started).getTime() : 0;
    return Number.isFinite(t) ? t : 0;
}

/** 메시지와 지금 스와이프 둘 다에 도장 */
function putStamp(message, stamp) {
    message.extra = message.extra || {};
    message.extra[KEY] = stamp;
    const info = Array.isArray(message.swipe_info) ? message.swipe_info[message.swipe_id ?? 0] : null;
    if (info) {
        info.extra = info.extra || {};
        info.extra[KEY] = structuredClone(stamp);
    }
}

/** 예전 프리셋 기록 확장이 남긴 chat_metadata.presetsBySwipeKey 를 읽기만 함 */
function legacyStamp(data) {
    const store = ctx().chatMetadata?.presetsBySwipeKey;
    if (!store || typeof store !== 'object' || !data?.send_date) return null;
    const model = data.extra?.model || '';
    const key = `${String(data.send_date).replace(/\s+/g, '').toLowerCase()}_model_${(model || 'unknown').toLowerCase()}`;
    const v = store[key];
    if (!v) return null;
    if (typeof v === 'string') return { model, api: data.extra?.api || '', preset: v, via: 'legacy' };
    if (typeof v !== 'object') return null;
    const stamp = { model: v.forcedModel || model, api: data.extra?.api || '', preset: v.genPreset || null, via: 'legacy' };
    if ('ctxTpl' in v) stamp.context = v.ctxTpl;
    if ('insTpl' in v) stamp.instruct = v.insTpl;
    if ('sysPpt' in v) stamp.sysprompt = v.sysPpt;
    return stamp;
}

/** 그 판의 도장: 우리 도장 → 예전 기록 → 없음 */
function stampOf(data) {
    return data?.extra?.[KEY] || legacyStamp(data) || null;
}

// ---------------- /cut → /sendas 짝 찾기 ----------------

function remember() {
    snapshot = ctx().chat?.slice() ?? [];
}

function onDeleted() {
    const chat = ctx().chat ?? [];
    const alive = new Set(chat);
    const now = Date.now();
    for (const m of snapshot) {
        if (m && !alive.has(m) && !m.is_user && !m.is_system) removed.push({ msg: m, at: now });
    }
    removed = removed.filter(r => now - r.at < REMOVED_TTL_MS).slice(-10);
    snapshot = chat.slice();
}

/** 새 글 안에 방금 지운 메시지 글이 그대로 들어 있으면 그 메시지 (「디테일」 같은 QR) */
function takeCutSource(text) {
    const squash = (t) => String(t ?? '').replace(/\s+/g, '');
    const body = squash(text);
    const now = Date.now();
    for (let i = removed.length - 1; i >= 0; i--) {
        const { msg, at } = removed[i];
        if (now - at >= REMOVED_TTL_MS) continue;
        const old = squash(msg.mes);
        if (old.length >= 20 && body.includes(old)) {
            removed.splice(i, 1);
            return msg;
        }
    }
    return null;
}

// ---------------- 채팅을 옮긴 뒤 늦게 붙는 답 ----------------

function chatId() {
    try { return ctx().getCurrentChatId() || null; } catch { return null; }
}

function rememberLate(stamp) {
    const id = chatId();
    if (!id) return;
    const now = Date.now();
    const list = (lateByChat.get(id) || []).filter(e => now - e.at < LATE_TTL_MS);
    list.push({ stamp, at: stamp.at });
    lateByChat.set(id, list.slice(-5));
}

/** 이 메시지(지금 판)의 생성 시작 시각과 맞는 이 채팅의 시작 도장을 꺼냄 */
function takeLate(message) {
    const id = chatId();
    const list = id && lateByChat.get(id);
    if (!list?.length) return null;
    const t = startedAt(activeData(message)) || startedAt(message);
    if (!t) return null;
    let best = -1;
    for (let i = 0; i < list.length; i++) {
        const d = t - list[i].at;
        if (d >= -60 * 1000 && d <= LATE_MATCH_MS && (best < 0 || Math.abs(d) < Math.abs(t - list[best].at))) best = i;
    }
    if (best < 0) return null;
    const [entry] = list.splice(best, 1);
    return entry.stamp;
}

function dropLate(stamp) {
    const id = chatId();
    const list = id && lateByChat.get(id);
    if (!list) return;
    const i = list.findIndex(e => e.stamp === stamp);
    if (i >= 0) list.splice(i, 1);
}

// ---------------- 이벤트 ----------------

function onGenerationStarted(type, _options, dryRun) {
    if (dryRun) return;
    if (type === 'quiet') {
        pendingQuiet = { stamp: makeStamp('quiet'), at: Date.now() };
    } else if (type !== 'impersonate') {
        const last = ctx().chat?.at(-1);
        pendingGen = { stamp: makeStamp('gen'), type, at: Date.now(), before: startedAt(last) };
        rememberLate(pendingGen.stamp);
        pendingQuiet = null;   // 보통 생성이 시작되면 앞선 /gen 흐름은 끝난 것
    }
}

/** 새 스와이프를 만들기 시작할 때: 실리태번이 새 스와이프에 앞 스와이프의 extra 를 물려주므로 그 도장을 뗌 */
function onSwiped(messageId) {
    const message = ctx().chat?.[Number(messageId)];
    if (!message?.extra?.[KEY] || message.is_user) return;
    const id = message.swipe_id ?? 0;
    if (Array.isArray(message.swipe_info) && !message.swipe_info[id]) delete message.extra[KEY];
}

/**
 * 생성이 끝났는데 「답 받음」 신호가 없었으면(스와이프 · 이어 쓰기가 도중에 오류로 끊긴 경우 실리태번이 안 보냄)
 * 이번 생성으로 글이 생긴 마지막 답에 도장을 찍음
 */
function onGenerationDone() {
    const pending = pendingGen;
    if (!pending) return;
    setTimeout(() => {
        if (pendingGen !== pending) return; // 그새 「답 받음」에서 찍었거나 새 생성이 시작됨
        pendingGen = null;
        const message = ctx().chat?.at(-1);
        if (!message || message.is_user || message.is_system) return;
        if (activeData(message).extra?.[KEY] && pending.type === 'continue') return;
        const t = startedAt(message);
        // 이번 생성으로 바뀐 답만 (앞 답보다 늦게, 이번 생성 시작 즈음에 시작한 것)
        if (!t || t <= pending.before || t < pending.at - 60 * 1000) return;
        putStamp(message, pending.stamp);
        dropLate(pending.stamp);
        saveChatDebounced();
    }, FALLBACK_DELAY_MS);
}

function onMessageReceived(messageId, type) {
    const chat = ctx().chat;
    const message = chat?.[Number(messageId)];
    if (!message || message.is_user) return;

    if (type === 'command') {
        // /sendas 등: 방금 잘라 낸 답을 다시 넣은 것이거나, 실리태번이 모델을 'slash command' 로 적은 메시지만
        // (다른 확장이 먼저 모델을 고쳐 놓았을 수도 있어서 잘라 낸 답 짝부터 찾음)
        let stamp = null;
        const source = takeCutSource(message.mes);
        if (!source && message.extra?.model !== SLASH_MODEL && !message.extra?.via_quick_reply) return;
        if (source) {
            const data = activeData(source);
            const old = stampOf(data);
            stamp = old ? { ...structuredClone(old), via: 'cut' }
                : (data.extra?.model && data.extra.model !== SLASH_MODEL ? { model: data.extra.model, api: data.extra.api || '', preset: null, via: 'cut' } : null);
        } else if (pendingQuiet && Date.now() - pendingQuiet.at < QUIET_TTL_MS) {
            stamp = pendingQuiet.stamp;
            pendingQuiet = null;
        }
        if (!stamp) return;
        putStamp(message, stamp);
        reapply = { send_date: message.send_date, mes: message.mes, stamp, model: source ? stamp.model : null, api: source ? stamp.api : null, at: Date.now() };
        // 잘라 다시 넣은 답이면 실리태번 자체 기록(시간 글자에 마우스 올리면 보이는 모델)도 원래 모델로.
        // /gen 짝은 시간으로만 맞춘 것이라 실리태번 기록은 건드리지 않음
        if (source && stamp.model && stamp.model !== SLASH_MODEL) {
            for (const target of new Set([message, activeData(message)])) {
                target.extra = target.extra || {};
                target.extra.model = stamp.model;
                if (stamp.api) target.extra.api = stamp.api;
            }
        }
        saveChatDebounced();
        return;
    }

    if (type === 'first_message' || type === 'extension') return;

    // quiet 생성이 채팅에 답으로 들어온 경우(quietToLoud)
    if (type === 'quiet') {
        if (!pendingQuiet) return;
        const stamp = { ...pendingQuiet.stamp, via: 'gen' };
        pendingQuiet = null;
        putStamp(message, stamp);
        return;
    }

    pendingQuiet = null;   // 생성한 답이 왔으면 앞선 /gen 흐름은 끝난 것
    const pending = pendingGen;
    pendingGen = null;
    // 생성 중에 채팅을 옮겨 대기 도장이 없으면: 이 채팅에서 시작한 생성 중 시각이 맞는 것
    const stamp = pending ? pending.stamp : takeLate(message);
    if (!stamp) return;
    if (pending) dropLate(pending.stamp);
    // 이어 쓰기는 처음 도장을 그대로 둠
    if (type === 'continue' && activeData(message).extra?.[KEY]) return;
    putStamp(message, stamp);
}

/** /sendas at= 처럼 신호 뒤 채팅을 서버에서 다시 읽으면 메모리에 붙인 도장이 사라져서, 같은 메시지를 찾아 다시 붙임 */
function reapplyAfterReload() {
    const r = reapply;
    if (!r || Date.now() - r.at > REAPPLY_MS) { reapply = null; return; }
    const message = (ctx().chat || []).find(m => m && !m.is_user && m.send_date === r.send_date && m.mes === r.mes);
    if (!message) return;
    reapply = null;
    if (message.extra?.[KEY]) return;
    putStamp(message, r.stamp);
    if (r.model) {
        for (const target of new Set([message, activeData(message)])) {
            target.extra = target.extra || {};
            target.extra.model = r.model;
            if (r.api) target.extra.api = r.api;
        }
    }
    saveChatDebounced();
}

function onChatChanged() {
    reapplyAfterReload();
    pendingGen = null;
    pendingQuiet = null;
    removed = [];
    remember();
}

// ---------------- 보여 주기 ----------------

function offText(v) {
    return v === false ? '꺼짐' : (v || '(알 수 없음)');
}

/** 캐릭터 이름을 누르면: 그 답(지금 스와이프)의 정보를 알림으로 (보일 것은 설정에서) */
function showStamp(messageId) {
    const message = ctx().chat?.[Number(messageId)];
    if (!message || message.is_user) return;
    const show = settings().show;
    const data = activeData(message);
    const stamp = stampOf(data);
    const swipes = Array.isArray(message.swipes) ? message.swipes.length : 1;
    const title = `메시지 #${messageId}${swipes > 1 ? ` (스와이프 ${(message.swipe_id ?? 0) + 1})` : ''} 정보`;
    const line = (label, value) => `<b>${escapeHtml(label)}:</b> ${escapeHtml(value)}<br>`;

    let html = '';
    if (show.model) html += line('모델', stamp?.model || data.extra?.model || '(알 수 없음)');
    if (show.api && (stamp?.api || data.extra?.api)) html += line('연결', stamp?.api || data.extra.api);
    if (show.profile && stamp?.profile) html += line('연결 프로필', stamp.profile);
    if (show.preset) html += line('프리셋', stamp?.preset || '(기록 없음)');
    const textCompletion = show.templates && stamp && ('context' in stamp || 'instruct' in stamp || 'sysprompt' in stamp);
    if (textCompletion) {
        html += line('컨텍스트 템플릿', offText(stamp.context));
        html += line('지시 템플릿', offText(stamp.instruct));
        html += line('시스템 프롬프트', offText(stamp.sysprompt));
    }
    if (show.time && stamp?.at) html += line('생성 시작', new Date(stamp.at).toLocaleString('ko-KR'));
    if (!html) html = '<small>설정에서 보일 정보를 켜 주세요.</small>';

    toastr.info(html, title, {
        closeButton: true, progressBar: true, positionClass: 'toast-top-center',
        timeOut: textCompletion ? 9000 : 5000, extendedTimeOut: 2000, escapeHtml: false,
    });
}

async function addSettings() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;
    host.insertAdjacentHTML('beforeend', await (await fetch(new URL('settings.html', import.meta.url))).text());
    const show = settings().show;
    for (const box of document.querySelectorAll('#ps_settings input[data-show]')) {
        box.checked = !!show[box.dataset.show];
        box.addEventListener('change', () => {
            settings().show[box.dataset.show] = box.checked;
            ctx().saveSettingsDebounced();
        });
    }
}

jQuery(async () => {
    settings();
    const { eventSource, eventTypes } = ctx();

    eventSource.on(eventTypes.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(eventTypes.MESSAGE_RECEIVED, (id, type) => {
        try { onMessageReceived(id, type); } catch (err) { console.warn('[Preset Stamp]', err); }
        remember();
    });
    eventSource.on(eventTypes.MESSAGE_DELETED, onDeleted);
    eventSource.on(eventTypes.MESSAGE_SWIPED, onSwiped);
    eventSource.on(eventTypes.GENERATION_ENDED, onGenerationDone);
    eventSource.on(eventTypes.GENERATION_STOPPED, onGenerationDone);
    eventSource.on(eventTypes.MESSAGE_SENT, () => { pendingQuiet = null; }); // 사람이 글을 보내면 QR 흐름은 끝난 것
    eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
    for (const ev of [eventTypes.MESSAGE_SENT, eventTypes.MESSAGE_SWIPED, eventTypes.GENERATION_ENDED, eventTypes.USER_MESSAGE_RENDERED]) {
        eventSource.on(ev, remember);
    }
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, remember);
    remember();
    // 신호 없이 붙는 메시지(다른 확장이 직접 넣은 것)도 사본에 들어가게 — 화면에 메시지가 붙을 때만 (지울 때는 사본을 그대로 둬야 지운 것을 알 수 있음)
    const chatEl = document.getElementById('chat');
    if (chatEl) {
        let queued = false;
        new MutationObserver(records => {
            if (queued || !records.some(r => [...r.addedNodes].some(n => n.nodeType === 1 && n.classList?.contains('mes')))) return;
            queued = true;
            queueMicrotask(() => { queued = false; remember(); });
        }).observe(chatEl, { childList: true });
    }

    $(document).on('click', '#chat .mes .name_text', function () {
        const mes = $(this).closest('.mes');
        if (mes.attr('is_user') === 'true') return;
        showStamp(mes.attr('mesid'));
    });

    try { await addSettings(); } catch (err) { console.warn('[Preset Stamp] settings', err); }
});
