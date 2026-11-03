// Preset Stamp — 답(스와이프)마다 어떤 모델 · 프리셋으로 만들었는지 그 메시지에 도장처럼 적어 둠.
// 기록: message.extra.preset_stamp 와 swipe_info[n].extra.preset_stamp (실리태번이 스와이프를 오갈 때 extra 를 같이 옮김)
//   { model, api, preset, profile?, context?, instruct?, sysprompt?, at, via }
//   via: 'gen' 생성 시작 때 · 'cut' /cut → /sendas 로 옮긴 답(원래 도장 이어받음) · 'quiet' /gen → /sendas
// 메시지를 지우면 도장도 같이 사라지고, 분기 채팅에도 따라감 — 따로 정리할 것이 없음.

import { getGeneratingModel, getGeneratingApi, main_api, saveChatDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { power_user } from '../../../power-user.js';

const KEY = 'preset_stamp';
const QUIET_TTL_MS = 10 * 60 * 1000;   // /gen 이 오래 걸려도 뒤따르는 /sendas 가 받을 수 있게
const REMOVED_TTL_MS = 60 * 1000;      // /cut 바로 뒤 /sendas 만 짝지음
const SLASH_MODEL = 'slash command';   // 실리태번이 /sendas 메시지에 적는 모델 이름
const ctx = () => SillyTavern.getContext();

let pendingGen = null;    // 보통 생성이 시작될 때 찍어 둔 도장
let pendingQuiet = null;  // quiet 생성(/gen)이 시작될 때 찍어 둔 도장 { stamp, at }
let snapshot = [];        // 메시지 목록 사본(참조만) — /cut 으로 지워진 메시지를 알아내려고
let removed = [];         // 최근 지워진 AI 메시지 { msg, at }

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
    return info || message;
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

/** 옛 PresetTrackerEnhanced 기록(chat_metadata.presetsBySwipeKey)을 읽기만 함 */
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

/** 그 판의 도장: 우리 도장 → 옛 트래커 기록 → 없음 */
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

// ---------------- 이벤트 ----------------

function onGenerationStarted(type, _options, dryRun) {
    if (dryRun) return;
    if (type === 'quiet') {
        pendingQuiet = { stamp: makeStamp('quiet'), at: Date.now() };
    } else if (type !== 'impersonate') {
        pendingGen = makeStamp('gen');
    }
}

function onMessageReceived(messageId, type) {
    const chat = ctx().chat;
    const message = chat?.[Number(messageId)];
    if (!message || message.is_user) return;

    if (type === 'command') {
        // /sendas 등: 방금 잘라 낸 답을 다시 넣은 것이거나, 실리태번이 모델을 'slash command' 로 적은 메시지만
        // (옛 Preset Tracker 가 먼저 모델을 고쳐 놓았을 수도 있어서 잘라 낸 답 짝부터 찾음)
        let stamp = null;
        const source = takeCutSource(message.mes);
        if (!source && message.extra?.model !== SLASH_MODEL && !message.extra?.via_quick_reply) return;
        if (source) {
            const old = stampOf(activeData(source)) || stampOf(source);
            const data = activeData(source);
            stamp = old ? { ...structuredClone(old), via: 'cut' }
                : (data.extra?.model && data.extra.model !== SLASH_MODEL ? { model: data.extra.model, api: data.extra.api || '', preset: null, via: 'cut' } : null);
        } else if (pendingQuiet && Date.now() - pendingQuiet.at < QUIET_TTL_MS) {
            stamp = pendingQuiet.stamp;
            pendingQuiet = null;
        }
        if (!stamp) return;
        putStamp(message, stamp);
        // 실리태번 자체 기록(시간 글자에 마우스 올리면 보이는 모델)도 원래 모델로
        if (stamp.model && stamp.model !== SLASH_MODEL) {
            for (const target of [message, activeData(message)]) {
                target.extra = target.extra || {};
                target.extra.model = stamp.model;
                if (stamp.api) target.extra.api = stamp.api;
            }
        }
        saveChatDebounced();
        return;
    }

    if (type === 'first_message' || type === 'extension') return;
    const stamp = pendingGen;
    pendingGen = null;
    if (!stamp) return;
    // 이어 쓰기는 처음 도장을 그대로 둠
    if (type === 'continue' && message.extra?.[KEY]) return;
    putStamp(message, stamp);
}

function onChatChanged() {
    pendingGen = null;
    pendingQuiet = null;
    removed = [];
    remember();
}

// ---------------- 보여 주기 ----------------

const VIA_TEXT = {
    cut: '잘라 다시 넣은 답 — 원래 답의 기록',
    quiet: '/gen → /sendas',
    legacy: '옛 Preset Tracker 기록',
};

function offText(v) {
    return v === false ? '꺼짐' : (v || '(알 수 없음)');
}

/** 캐릭터 이름을 누르면: 그 답(지금 스와이프)의 모델 · 프리셋을 알림으로 */
function showStamp(messageId) {
    const message = ctx().chat?.[Number(messageId)];
    if (!message || message.is_user) return;
    const data = activeData(message);
    const stamp = stampOf(data);
    const swipes = Array.isArray(message.swipes) ? message.swipes.length : 1;
    const title = `메시지 #${messageId}${swipes > 1 ? ` (스와이프 ${(message.swipe_id ?? 0) + 1})` : ''} 정보`;
    const line = (label, value) => `<b>${escapeHtml(label)}:</b> ${escapeHtml(value)}<br>`;

    let html = line('모델', stamp?.model || data.extra?.model || '(알 수 없음)');
    if (stamp?.profile) html += line('연결 프로필', stamp.profile);
    html += line('프리셋', stamp?.preset || '(기록 없음)');
    const textCompletion = stamp && ('context' in stamp || 'instruct' in stamp || 'sysprompt' in stamp);
    if (textCompletion) {
        html += line('컨텍스트 템플릿', offText(stamp.context));
        html += line('지시 템플릿', offText(stamp.instruct));
        html += line('시스템 프롬프트', offText(stamp.sysprompt));
    }
    if (VIA_TEXT[stamp?.via]) html += `<small>${escapeHtml(VIA_TEXT[stamp.via])}</small>`;

    toastr.info(html, title, {
        closeButton: true, progressBar: true, positionClass: 'toast-top-center',
        timeOut: textCompletion ? 9000 : 5000, extendedTimeOut: 2000, escapeHtml: false,
    });
}

jQuery(() => {
    const { eventSource, eventTypes } = ctx();

    eventSource.on(eventTypes.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(eventTypes.MESSAGE_RECEIVED, (id, type) => {
        try { onMessageReceived(id, type); } catch (err) { console.warn('[Preset Stamp]', err); }
        remember();
    });
    eventSource.on(eventTypes.MESSAGE_DELETED, onDeleted);
    eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
    for (const ev of [eventTypes.MESSAGE_SENT, eventTypes.MESSAGE_SWIPED, eventTypes.GENERATION_ENDED, eventTypes.USER_MESSAGE_RENDERED]) {
        eventSource.on(ev, remember);
    }
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, remember);
    remember();

    $(document).on('click', '#chat .mes .name_text', function () {
        const mes = $(this).closest('.mes');
        if (mes.attr('is_user') === 'true') return;
        showStamp(mes.attr('mesid'));
    });
});
