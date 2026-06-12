// ============================================================
//  ÚY — AI Housing Navigator | app.js v2
//  AI Scoring + RAG (реальные документы программ)
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getFirestore, collection, addDoc, serverTimestamp, doc, getDoc, setDoc }
  from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

// ─── FIREBASE CONFIG ──────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyCbEPNhRIQchI_BemvIhzIvghbBSlldjUo",
  authDomain: "ai-housing-navigator.firebaseapp.com",
  projectId: "ai-housing-navigator",
  storageBucket: "ai-housing-navigator.firebasestorage.app",
  messagingSenderId: "957629999327",
  appId: "1:957629999327:web:43120f0a0e91c0d8bb216a",
  measurementId: "G-0RTRTCFTCP"
};

const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);

// ─── AI CONFIG ────────────────────────────────────────────
const AI_CONFIG = {
  endpoint: "https://api.groq.com/openai/v1/chat/completions",
  apiKey:   "TOKEN_Groq",
  model:    "llama-3.3-70b-versatile",
};

// ═══════════════════════════════════════════════════════════
//  RAG — БАЗА ЗНАНИЙ ЖИЛИЩНЫХ ПРОГРАММ КАЗАХСТАНА
//  Реальные условия программ. AI использует ТОЛЬКО их.
// ═══════════════════════════════════════════════════════════
import { KNOWLEDGE_BASE } from './knowledge.js';

// ─── SYSTEM PROMPT ────────────────────────────────────────
function buildSystemPrompt() {
  return `Ты — консультант по жилищным программам Казахстана (КЖК).

ИСПОЛЬЗУЙ ТОЛЬКО информацию из базы знаний ниже. Не придумывай программы.

${KNOWLEDGE_BASE}

ПРАВИЛА:
1. Простой язык, без терминов
2. Только программы из базы знаний
3. Вероятность считай по критериям скоринга
4. Объясняй причину каждого вывода
5. Если не подходит ни одна — честно скажи почему

ФОРМАТ (строго):

PROGRAM_START
🏠 ПРОГРАММА: [название]
📊 ВЕРОЯТНОСТЬ ОДОБРЕНИЯ: [число]%
📌 ПОЧЕМУ ПОДХОДИТ: [2-3 предложения]
💡 УСЛОВИЯ:
- [условие]
- [условие]
📋 ПЛАН ДЕЙСТВИЙ:
1. [шаг]
2. [шаг]
3. [шаг]
4. [шаг]
5. [шаг]
⚠️ РИСКИ И ВАЖНО ЗНАТЬ: [момент]
PROGRAM_END

SCORING_START
📊 AI АНАЛИЗ ПРОФИЛЯ:
✅ Сильные стороны:
- [пункт]
❌ Слабые стороны:
- [пункт]
💡 Что улучшить:
- [конкретный совет]
SCORING_END

SUMMARY_START
💬 [Общая рекомендация 3-4 предложения]
SUMMARY_END`;
}

// ─── STATE ────────────────────────────────────────────────
let userData = {};
let conversationHistory = [];
let currentSessionId = null;

// ─── PILL SELECTION ───────────────────────────────────────
document.querySelectorAll('.pill-group').forEach(group => {
  group.querySelectorAll('.pill').forEach(pill => {
    pill.addEventListener('click', () => {
      group.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
      pill.classList.toggle('active');
      userData[group.id] = pill.classList.contains('active') ? pill.dataset.value : '';
    });
  });
});

// ─── LOCAL SCORING ────────────────────────────────────────
function calcScore(d) {
  const age = parseInt(d.age) || 0;
  const income = parseInt(d.income) || 0;
  const children = parseInt(d.children) || 0;

  if (age < 18) return 0;
  if (income === 0 && (d.goal === 'mortgage' || d.goal === 'buy')) return 0;
  if (d.employment === 'unemployed' && d.goal === 'mortgage') return 0;
  if (d.hasHousing === 'yes' && d.goal === 'buy') return 5;

  let s = 30;
  if (income >= 255000) s += 25;
  else if (income >= 170000) s += 15;
  else if (income >= 85000) s += 5;
  else s -= 15;

  if (d.hasHousing === 'no') s += 20;
  else if (d.hasHousing === 'renting') s += 10;
  if (children >= 3) s += 20;
  else if (children >= 1) s += 10;
  if (d.maritalStatus === 'married') s += 10;
  if (age >= 25 && age <= 35) s += 10;
  else if (age >= 35 && age <= 50) s += 5;
  else if (age < 21) s -= 15;
  if (d.employment === 'state') s += 30;
  else if (d.employment === 'employed') s += 25;
  else if (d.employment === 'self') s -= 10;
  else if (d.employment === 'unemployed') s -= 25;

  return Math.max(5, Math.min(s, 97));
}

function buildUserPrompt(data) {
  const goals   = { buy: 'купить жильё', rent: 'арендное жильё', mortgage: 'льготная ипотека', waiting_list: 'встать в очередь' };
  const marital = { single: 'не женат/не замужем', married: 'женат/замужем', divorced: 'разведён' };
  const employ  = { employed: 'официально трудоустроен', self: 'самозанятый', state: 'госслужащий', unemployed: 'не работает' };
  const housing = { no: 'нет своего жилья', yes: 'есть своё жильё', renting: 'снимает жильё' };

  return `Проанализируй мой профиль по базе знаний:

👤 ПРОФИЛЬ:
- Возраст: ${data.age} лет
- Доход: ${Number(data.income).toLocaleString('ru')} тенге/месяц
- Город: ${data.city}
- Семейное положение: ${marital[data.maritalStatus] || 'не указано'}
- Детей: ${data.children || 0}
- Жильё: ${housing[data.hasHousing] || 'не указано'}
- Трудоустройство: ${employ[data.employment] || 'не указано'}
- Цель: ${goals[data.goal] || 'не указана'}
- Предварительный скоринг: ${calcScore(data)}/100

Подбери программы, рассчитай вероятность, дай AI анализ профиля.`;
}

// ─── AI CALL ──────────────────────────────────────────────
async function callAI(userMessage, isNew = false) {
  const messages = isNew
    ? [{ role: 'user', content: userMessage }]
    : [...conversationHistory, { role: 'user', content: userMessage }];

  const response = await fetch(AI_CONFIG.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AI_CONFIG.apiKey}`
    },
    body: JSON.stringify({
      model: AI_CONFIG.model,
      messages: [{ role: 'system', content: buildSystemPrompt() }, ...messages],
      temperature: 0.3,
      max_tokens: 2500
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`AI Error ${response.status}: ${err.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.choices[0].message.content;
}

// ─── PARSE ────────────────────────────────────────────────
function parseAIResponse(text) {
  const programs = [];
  const rx = /PROGRAM_START([\s\S]*?)PROGRAM_END/g;
  let m;
  while ((m = rx.exec(text)) !== null) programs.push(parseProg(m[1].trim()));

  const scoringM = text.match(/SCORING_START([\s\S]*?)SCORING_END/);
  const summaryM = text.match(/SUMMARY_START([\s\S]*?)SUMMARY_END/);

  return {
    programs,
    scoring: scoringM ? scoringM[1].trim() : '',
    summary: summaryM ? summaryM[1].trim() : '',
    raw: programs.length === 0 ? text : null
  };
}

function parseProg(block) {
  const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
  const p = { name: '', probability: 0, why: '', conditions: [], steps: [], risks: [] };
  let mode = '';

  lines.forEach(l => {
    if (l.startsWith('🏠 ПРОГРАММА:'))     { p.name = l.replace('🏠 ПРОГРАММА:', '').trim(); }
    else if (l.startsWith('📊 ВЕРОЯТНОСТЬ')) { const x = l.match(/(\d+)/); p.probability = x ? parseInt(x[1]) : calcScore(userData); }
    else if (l.startsWith('📌 ПОЧЕМУ'))     { p.why = l.replace('📌 ПОЧЕМУ ПОДХОДИТ:', '').trim(); mode = 'why'; }
    else if (l.startsWith('💡 УСЛОВИЯ'))    { mode = 'conditions'; }
    else if (l.startsWith('📋 ПЛАН'))       { mode = 'steps'; }
    else if (l.startsWith('⚠️ РИСКИ'))      { p.risks.push(l.replace('⚠️ РИСКИ И ВАЖНО ЗНАТЬ:', '').trim()); mode = 'risks'; }
    else {
      if (mode === 'why' && !p.why) p.why = l;
      else if (mode === 'conditions' && (l.startsWith('-') || l.startsWith('•'))) p.conditions.push(l.replace(/^[-•]\s*/, ''));
      else if (mode === 'steps' && /^\d+\./.test(l)) p.steps.push(l.replace(/^\d+\.\s*/, ''));
      else if (mode === 'risks' && l) p.risks.push(l.replace(/^[-•]\s*/, ''));
    }
  });

  if (!p.probability) p.probability = calcScore(userData);
  return p;
}

// ─── MAIN ─────────────────────────────────────────────────
window.analyzeUser = async function() {
  userData.age      = document.getElementById('age').value;
  userData.income   = document.getElementById('income').value;
  userData.city     = document.getElementById('city').value;
  userData.children = document.getElementById('children').value;

  if (!userData.age || !userData.income || !userData.city) { shakeForm(); return; }

  const btn = document.getElementById('analyzeBtn');
  btn.disabled = true; btn.textContent = 'Анализирую...';
  showState('loading'); animateLoadingSteps();

  try {
    const result = await callAI(buildUserPrompt(userData), true);
    const parsed = parseAIResponse(result);
    await saveToFirebase(userData, result);
    displayResults(parsed);
    showState('result');
    conversationHistory = [
      { role: 'user', content: buildUserPrompt(userData) },
      { role: 'assistant', content: result }
    ];
    document.getElementById('chatSection').classList.remove('hidden');
  } catch (err) {
    console.error(err); showErrorState(err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-icon">🔍</span> Найти мои программы';
  }
};

// ─── RENDER ───────────────────────────────────────────────
function displayResults(parsed) {
  const c = document.getElementById('resultContent');
  c.innerHTML = '';

  if (parsed.raw) {
    c.innerHTML = `<div class="summary-card"><h3>💬 Результат</h3><p style="white-space:pre-wrap">${parsed.raw}</p></div>`;
    return;
  }

  parsed.programs.forEach((prog, i) => { c.innerHTML += renderProgramCard(prog, i === 0); });

  if (parsed.scoring) c.innerHTML += renderScoringCard(parsed.scoring);

  if (parsed.summary) {
    c.innerHTML += `<div class="summary-card"><h3>💬 Общая рекомендация</h3><p>${parsed.summary.replace('💬','').trim()}</p></div>`;
  }

  setTimeout(() => {
    document.querySelectorAll('.approval-bar').forEach(bar => { bar.style.width = bar.dataset.width + '%'; });
  }, 100);
}

function renderScoringCard(scoring) {
  const lines = scoring.split('\n').map(l => l.trim()).filter(Boolean);
  let strong = [], weak = [], improve = [], mode = '';

  lines.forEach(l => {
    if (l.includes('Сильные')) mode = 'strong';
    else if (l.includes('Слабые')) mode = 'weak';
    else if (l.includes('улучшить')) mode = 'improve';
    else if (l.startsWith('-') || l.startsWith('•')) {
      const v = l.replace(/^[-•]\s*/, '');
      if (mode === 'strong') strong.push(v);
      else if (mode === 'weak') weak.push(v);
      else if (mode === 'improve') improve.push(v);
    }
  });

  return `
    <div class="scoring-card">
      <div class="scoring-title">🤖 AI Анализ профиля</div>
      <div class="scoring-subtitle">На основе реальных критериев программ КЖК</div>
      <div class="scoring-grid">
        ${strong.map(s  => `<div class="score-item score-good">✅ ${s}</div>`).join('')}
        ${weak.map(w    => `<div class="score-item score-bad">❌ ${w}</div>`).join('')}
        ${improve.map(i => `<div class="score-item score-tip">💡 ${i}</div>`).join('')}
      </div>
    </div>`;
}

function renderProgramCard(prog, isTop) {
  const pct = prog.probability;
  const col = pct >= 70 ? 'var(--accent-2)' : pct >= 50 ? 'var(--accent)' : 'var(--accent-warn)';

  return `
    <div class="program-card${isTop ? ' top' : ''}">
      <div class="card-badge${isTop ? ' top-badge' : ''}">${isTop ? '⭐ Лучшее совпадение' : '📋 Подходит вам'}</div>
      <div class="program-name">${prog.name || 'Жилищная программа'}</div>
      <div class="approval-row">
        <span class="approval-label">Вероятность одобрения</span>
        <div class="approval-bar-wrap">
          <div class="approval-bar" data-width="${pct}" style="width:0%;background:linear-gradient(90deg,${col},var(--accent))"></div>
        </div>
        <span class="approval-pct" style="color:${col}">${pct}%</span>
      </div>
      ${prog.why ? `<div class="card-section"><div class="card-section-title">Почему подходит</div><p>${prog.why}</p></div>` : ''}
      ${prog.conditions.length ? `<div class="card-section"><div class="card-section-title">Условия</div><ul class="steps-list">${prog.conditions.map(c=>`<li><span class="step-num">✓</span>${c}</li>`).join('')}</ul></div>` : ''}
      ${prog.steps.length ? `<div class="card-section"><div class="card-section-title">📋 Пошаговый план</div><ul class="steps-list">${prog.steps.map((s,i)=>`<li><span class="step-num">${i+1}</span>${s}</li>`).join('')}</ul></div>` : ''}
      ${prog.risks.filter(Boolean).map(r=>`<div class="risk-item">⚠️ ${r}</div>`).join('')}
    </div>`;
}

// ─── CHAT ─────────────────────────────────────────────────
window.sendChat = async function() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  addChatMessage(text, 'user');
  const tid = addChatMessage('Думаю...', 'bot');
  try {
    const reply = await callAI(text, false);
    conversationHistory.push({ role: 'user', content: text });
    conversationHistory.push({ role: 'assistant', content: reply });
    updateChatMessage(tid, reply);
    await saveRequest(text, reply);
  } catch (err) {
    updateChatMessage(tid, 'Ошибка. Попробуйте ещё раз.');
  }
};

function addChatMessage(text, role) {
  const c = document.getElementById('chatMessages');
  const id = 'msg-' + Date.now();
  c.innerHTML += `<div class="msg ${role}" id="${id}"><div class="msg-avatar">${role==='user'?'👤':'🤖'}</div><div class="msg-bubble">${text}</div></div>`;
  c.scrollTop = c.scrollHeight;
  return id;
}
function updateChatMessage(id, text) {
  const el = document.getElementById(id);
  if (el) el.querySelector('.msg-bubble').textContent = text;
}

// ─── FIREBASE ─────────────────────────────────────────────
async function saveToFirebase(userData, result) {
  try {
    const ref = await addDoc(collection(db, 'users'), {
      age: parseInt(userData.age)||0, income: parseInt(userData.income)||0,
      city: userData.city, maritalStatus: userData.maritalStatus||'',
      children: parseInt(userData.children)||0, hasHousing: userData.hasHousing||'',
      goal: userData.goal||'', employment: userData.employment||'',
      aiScore: calcScore(userData), result, timestamp: serverTimestamp()
    });
    currentSessionId = ref.id;
    await addDoc(collection(db, 'requests'), {
      sessionId: ref.id, prompt: buildUserPrompt(userData), response: result, timestamp: serverTimestamp()
    });
    await updateAnalytics(userData.goal, userData.city);
  } catch (err) { console.warn('Firebase:', err.message); }
}

async function saveRequest(prompt, response) {
  try {
    await addDoc(collection(db, 'requests'), { sessionId: currentSessionId, prompt, response, timestamp: serverTimestamp() });
  } catch (err) { console.warn(err.message); }
}

async function updateAnalytics(goal, city) {
  try {
    for (const [key, val] of [['goal', goal], ['city', city]]) {
      const ref = doc(db, 'analytics', `${key}_${val}`);
      const snap = await getDoc(ref);
      await setDoc(ref, { type: key, value: val, count: snap.exists() ? snap.data().count + 1 : 1 });
    }
  } catch (err) { console.warn(err.message); }
}

// ─── UI ───────────────────────────────────────────────────
function showState(state) {
  ['welcomeState','loadingState','resultState'].forEach(id => document.getElementById(id).classList.add('hidden'));
  document.getElementById({welcome:'welcomeState',loading:'loadingState',result:'resultState'}[state]).classList.remove('hidden');
}
function animateLoadingSteps() {
  ['step1','step2','step3'].forEach((id,i) => setTimeout(() => {
    document.querySelectorAll('.step').forEach(s=>s.classList.remove('active'));
    const el = document.getElementById(id);
    if (el) { el.classList.add('active'); if(i>0) document.getElementById(['step1','step2','step3'][i-1]).classList.add('done'); }
  }, i*1200));
}
function shakeForm() {
  const btn = document.getElementById('analyzeBtn');
  btn.style.background='var(--accent-danger)'; btn.textContent='⚠️ Заполните все поля';
  setTimeout(()=>{ btn.style.background=''; btn.innerHTML='<span class="btn-icon">🔍</span> Найти мои программы'; }, 2000);
}
function showErrorState(msg) {
  document.getElementById('resultContent').innerHTML = `<div class="summary-card" style="border-color:rgba(247,95,95,.3)"><h3 style="color:var(--accent-danger)">⚠️ Ошибка</h3><p>Не удалось получить ответ от AI.</p><p style="margin-top:8px;font-size:12px;color:var(--text-3)">${msg}</p></div>`;
  showState('result');
}
window.resetForm = function() {
  userData={}; conversationHistory=[];
  document.querySelectorAll('.pill').forEach(p=>p.classList.remove('active'));
  ['age','income','children'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('city').value='';
  document.getElementById('chatMessages').innerHTML='';
  document.getElementById('chatSection').classList.add('hidden');
  showState('welcome');
};