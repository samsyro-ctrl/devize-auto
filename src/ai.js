// src/ai.js
// Un singur loc prin care trec toate cererile catre Claude -- prin OpenRouter
// (nu direct Anthropic), ca sa foloseasca creditul cumparat pe OpenRouter,
// workspace "Build & Fix" -- acelasi tipar deja in productie in
// recrutare-bot/src/ai.js (portat de-acolo aproape neschimbat).
//
// Apelantul (antemasuratoare.js) construieste "cerere" in formatul Anthropic
// Messages API (system, messages, max_tokens, output_config cu json_schema)
// -- neschimbat. Tot ce e specific OpenRouter (format OpenAI:
// response_format) se traduce AICI.
//
// Versiune simplificata fata de recrutare-bot -- aici nu exista alertare pe
// email (instrument local/single-firma, nu un serviciu cu colegi de anuntat)
// si nici contorizare de consum (fara panou de admin care sa citeasca
// pragurile) -- doar mesaj clar in consola.
'use strict';

const URL_OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';

// Scurtaturile deja folosite in .env (MODEL_EXTRAGERE/MODEL_SCOP/
// MODEL_COMPLETITUDINE), pastrate ca sa continue sa mearga neschimbate --
// acelasi HARTA_MODELE ca in recrutare-bot.
const HARTA_MODELE = {
  'claude-sonnet-5': 'anthropic/claude-sonnet-5',
  'claude-haiku-4-5': 'anthropic/claude-haiku-4.5', // atentie: cratima -> punct
};
/** Orice MODEL_* din .env poate fi acum ORICE model de pe OpenRouter -- un id
 * care deja contine "/" e un slug OpenRouter complet, trece neschimbat; una
 * din cele doua scurtaturi istorice se traduce; orice altceva trece prin ca
 * "anthropic/<id>" -- mai bine o incercare cu sens decat un crash. */
function mapModel(id) {
  if (HARTA_MODELE[id]) return HARTA_MODELE[id];
  if (String(id).includes('/')) return id;
  return `anthropic/${id}`;
}

/** Continutul unui mesaj (forma Anthropic: string sau lista de blocuri) ->
 * forma OpenRouter/OpenAI. Ramane string simplu cat timp mesajul e doar text
 * (comportament neschimbat pentru toti apelantii existenti) -- devine lista
 * de blocuri DOAR cand apare un bloc "image" (Robot B, cantitatiDesenatePT.js
 * -- o pagina PT randata ca imagine, trimisa unui model cu vedere). */
function traduContinut(content) {
  if (typeof content === 'string') return content;
  const areImagini = content.some((b) => b.type === 'image');
  if (!areImagini) return content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  return content.map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text };
    if (b.type === 'image') return { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } };
    return { type: 'text', text: '' };
  });
}

/** cerere (forma Anthropic) -> body OpenRouter (OpenAI-compatible). */
function traduCerere(cerere) {
  const mesaje = [];
  if (cerere.system) mesaje.push({ role: 'system', content: cerere.system });
  for (const m of cerere.messages) {
    mesaje.push({ role: m.role, content: traduContinut(m.content) });
  }

  // Suprascriere LIVE din pagina de Setari (setari_model, vezi db.js), citita
  // per apel -- nu la pornirea procesului -- ca o schimbare din panou sa se
  // aplice la urmatorul apel, fara restart. Fara "rol" pe cerere, sau fara
  // nicio suprascriere salvata, ramane exact modelul cerut de apelant.
  let suprascriere = null;
  if (cerere.rol) {
    try { suprascriere = require('./db').setariModel()[cerere.rol] || null; } catch { /* fara baza deschisa, folosim implicitul */ }
  }
  const model = mapModel(suprascriere || cerere.model);
  if (suprascriere) console.log(`   🔀 model suprascris pentru ${cerere.rol}: ${model}`);

  const body = { model, max_tokens: cerere.max_tokens, messages: mesaje };
  if (cerere.output_config?.format?.type === 'json_schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'output', strict: true, schema: cerere.output_config.format.schema },
    };
  }
  return body;
}

/** Felul erorii, ca sa stim ce sa afisam. Statusul HTTP (402=credit,
 * 401=cheie, 429=aglomerat) e semnalul principal -- verificat live contra
 * OpenRouter in recrutare-bot; regex-urile raman ca plasa secundara. */
function felEroare(e) {
  const status = e && e.status;
  if (status === 402) return 'credit';
  if (status === 401) return 'cheie';
  if (status === 429) return 'aglomerat';
  const t = String((e && e.message) || e || '');
  if (/credit balance is too low|billing|payment|insufficient.*(funds|credit)/i.test(t)) return 'credit';
  if (/authentication_error|invalid x-api-key|API key|user not found/i.test(t)) return 'cheie';
  if (/rate_limit|429|overloaded_error|529/i.test(t)) return 'aglomerat';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|socket hang up/i.test(t)) return 'retea';
  return 'altceva';
}

const MESAJE = {
  credit: 'S-au terminat creditele pe OpenRouter (workspace Build & Fix). Reincarca la openrouter.ai/settings/credits.',
  cheie: 'Problema cu OPENROUTER_API_KEY -- verifica .env.',
  aglomerat: 'Serviciul de AI e aglomerat chiar acum. Mai incearca peste un minut.',
  retea: 'Nu am putut ajunge la serviciul de AI. Mai incearca peste un minut.',
  altceva: 'Ceva n-a mers la apelul catre Claude. Mai incearca o data.',
};

const mesajOmenesc = (e) => MESAJE[felEroare(e)] || MESAJE.altceva;

/**
 * Cheama Claude, prin OpenRouter. Imparte erorile pe feluri, ca sa stii
 * repede daca problema e a ta (documentul/cererea) sau a serviciului
 * (credit/cheie/retea).
 * @param {object} cerere   in formatul Anthropic Messages API (system, messages,
 *   max_tokens, output_config.format.json_schema) -- tradus intern spre OpenRouter.
 * @param {string} unde     de unde vine apelul, pentru jurnal
 */
async function cheama(cerere, unde = 'necunoscut') {
  try {
    const r = await fetch(URL_OPENROUTER, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(traduCerere(cerere)),
    });
    const j = await r.json();
    if (!r.ok) {
      const e = new Error((j && j.error && j.error.message) || `OpenRouter a raspuns ${r.status}`);
      e.status = r.status;
      throw e;
    }
    const text = j.choices?.[0]?.message?.content;
    if (!text) throw new Error('Raspuns gol de la OpenRouter (fara choices[0].message.content).');
    // Anthropic API intoarce si "stop_reason" (verificat in antemasuratoare.js
    // pentru trunchiere la max_tokens) -- OpenRouter foloseste "finish_reason"
    // per alegere, tradus aici ca apelantul sa nu stie ca transportul s-a schimbat.
    const stopReason = j.choices?.[0]?.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
    return { content: [{ type: 'text', text }], stop_reason: stopReason };
  } catch (e) {
    console.error(`⚠️  Apel Claude esuat (${unde}): ${mesajOmenesc(e)}`);
    e.felAI = felEroare(e);
    e.mesajOmenesc = mesajOmenesc(e);
    throw e;
  }
}

module.exports = { cheama, felEroare, mesajOmenesc };
