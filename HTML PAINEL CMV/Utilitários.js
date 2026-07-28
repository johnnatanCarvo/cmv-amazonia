// ============================================================
//  Utilitarios.gs — Funções utilitárias de parsing/normalização
//  (dependem das constantes em Constantes.gs)
// ============================================================

function _removerAcentos(str) {
  return String(str).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().trim();
}

function _parseMesAno(mesStr) {
  if (!mesStr) return null;
  const limpo = _removerAcentos(String(mesStr)).replace(/^\d+[\.\s]+/, '');
  const partes = limpo.split(/\s+/).filter(Boolean);
  if (partes.length < 2) return null;
  const ano    = parseInt(partes[partes.length - 1]);
  const mesNum = partes.map(p => MESES_NUM[p]).find(v => v > 0);
  if (!mesNum || isNaN(ano)) return null;
  return { ano, mes: mesNum };
}

function _competenciaMatch(cellVal, mesRef) {
  const ref = _parseMesAno(mesRef);
  if (!ref) return false;
  if (cellVal instanceof Date) {
    return cellVal.getFullYear() === ref.ano && (cellVal.getMonth()+1) === ref.mes;
  }
  const cell = _parseMesAno(String(cellVal));
  if (cell) return cell.ano === ref.ano && cell.mes === ref.mes;
  return _removerAcentos(String(cellVal)) === _removerAcentos(mesRef);
}

function _labelMes(nomePasta) {
  return _removerAcentos(nomePasta).replace(/^\d+[\.\s]+/, '').trim();
}

function normalizarFilialGas(nome) {
  if (!nome) return null;
  const n = _removerAcentos(nome);
  for (const cfg of FILIAIS_CONFIG_GAS) {
    if (cfg.termos.map(_removerAcentos).some(t => n.includes(t))) return cfg.chave;
  }
  return String(nome).toUpperCase().trim();
}

function _parseNumGas(val) {
  if (val === undefined || val === null || val === '') return 0;
  if (typeof val === 'number') return val;
  let str = String(val).replace(/[R$\s]/g,'').trim();
  if (str.includes(',') && str.includes('.')) str = str.replace(/\./g,'').replace(',','.');
  else if (str.includes(',')) str = str.replace(',','.');
  return parseFloat(str) || 0;
}