// ============================================================
//  Persistencia.gs — Histórico compartilhado entre sessões/usuários
//  (depende de: nada — usa apenas PropertiesService)
//
//  Substitui os antigos localStorage do front-end (HIST_KEY, HIST_COMPRAS_KEY,
//  HIST_CMV_MES_KEY, ABC_HIST_KEY). Como o app roda com "access: ANYONE_ANONYMOUS",
//  localStorage ficava isolado por navegador/dispositivo — cada pessoa via um
//  "histórico" diferente e o comparativo mensal se perdia ao trocar de PC ou
//  limpar o cache. PropertiesService.getScriptProperties() é compartilhado por
//  TODOS os usuários do Web App, então o histórico passa a ser único e persistente.
//
//  Limite do PropertiesService: 9KB por propriedade, 500KB no total do script.
//  Por isso cada chave é gravada em chunks (mesmo padrão do CacheProcessamento.gs,
//  só que sem TTL — aqui o dado é permanente).
// ============================================================

const HIST_CHAVES_VALIDAS = ['HIST_CMV', 'HIST_COMPRAS', 'HIST_CMV_FILIAL', 'ABC_HIST'];
const HIST_CHUNK_TAM = 8500; // < 9KB, margem de segurança do limite por propriedade

function _propStore() {
  return PropertiesService.getScriptProperties();
}

// ─── API pública (chamada via google.script.run) ─────────────────────────────

// Carrega os 4 históricos de uma vez só (1 chamada no carregamento inicial do app)
function carregarHistoricoServidor() {
  const resultado = {};
  HIST_CHAVES_VALIDAS.forEach(chave => { resultado[chave] = _phCarregar(chave); });
  return resultado;
}

// Salva um histórico completo (overwrite da chave inteira — o front-end sempre
// manda o objeto já atualizado em memória, não deltas)
function salvarHistoricoServidor(chave, dadosObj) {
  if (HIST_CHAVES_VALIDAS.indexOf(chave) === -1) {
    throw new Error('Chave de histórico inválida: ' + chave);
  }
  _phGravar(chave, dadosObj || {});
  return { sucesso: true };
}

// Limpa uma ou mais chaves (usado pelo botão "Limpar histórico")
function limparHistoricoServidor(chaves) {
  const alvo = (chaves && chaves.length) ? chaves : HIST_CHAVES_VALIDAS;
  alvo.forEach(chave => {
    if (HIST_CHAVES_VALIDAS.indexOf(chave) !== -1) _phRemover(chave);
  });
  return { sucesso: true };
}

// ─── Internos: chunking em PropertiesService ──────────────────────────────────

function _phGravar(chave, obj) {
  try {
    const props = _propStore();
    _phRemover(chave); // limpa chunks antigos primeiro (evita sobrar lixo se o objeto encolher)
    const json   = JSON.stringify(obj);
    const chunks = Math.max(1, Math.ceil(json.length / HIST_CHUNK_TAM));
    const lote   = {};
    for (let i = 0; i < chunks; i++) {
      lote[chave + '_' + i] = json.substring(i * HIST_CHUNK_TAM, (i + 1) * HIST_CHUNK_TAM);
    }
    lote[chave + '_meta'] = String(chunks);
    props.setProperties(lote, false);
  } catch(e) {
    Logger.log('[Persistencia] Erro ao gravar "' + chave + '": ' + e.message);
    throw new Error('Erro ao salvar histórico (' + chave + '): ' + e.message);
  }
}

function _phCarregar(chave) {
  try {
    const props = _propStore();
    const meta  = props.getProperty(chave + '_meta');
    if (!meta) return {};
    const chunks = parseInt(meta, 10);
    const partes = [];
    for (let i = 0; i < chunks; i++) {
      const p = props.getProperty(chave + '_' + i);
      if (p === null) return {}; // chunk faltando = dado corrompido, melhor não usar
      partes.push(p);
    }
    return JSON.parse(partes.join(''));
  } catch(e) {
    Logger.log('[Persistencia] Erro ao ler "' + chave + '": ' + e.message);
    return {};
  }
}

function _phRemover(chave) {
  const props = _propStore();
  const meta  = props.getProperty(chave + '_meta');
  if (meta) {
    const chunks = parseInt(meta, 10);
    for (let i = 0; i < chunks; i++) props.deleteProperty(chave + '_' + i);
  }
  props.deleteProperty(chave + '_meta');
}