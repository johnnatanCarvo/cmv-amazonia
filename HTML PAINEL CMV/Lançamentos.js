// ============================================================
//  Lancamentos.gs — Leitura/persistência da planilha "Lançamentos"
//  (depende de Constantes.gs, Utilitarios.gs)
// ============================================================

function _getPlanilhaLancamentos() {
  if (ID_PLANILHA_LANCAMENTOS && ID_PLANILHA_LANCAMENTOS.length > 5) {
    return SpreadsheetApp.openById(ID_PLANILHA_LANCAMENTOS);
  }
  const pastaRaiz = DriveApp.getFolderById(ID_PASTA_RAIZ);
  const arqs = pastaRaiz.getFilesByName(NOME_PLANILHA_DB);
  if (arqs.hasNext()) return SpreadsheetApp.openById(arqs.next().getId());
  throw new Error('Planilha "Lançamentos" não encontrada. Verifique o ID_PLANILHA_LANCAMENTOS.');
}

function _getAbaLancamentos(ss) {
  const candidatos = ['Lançamentos','Lancamentos','DB_CMV_Lancamentos','Planilha1','Plan1','Sheet1','Página1'];
  for (const nome of candidatos) {
    const aba = ss.getSheetByName(nome);
    if (aba) return aba;
  }
  return ss.getSheets()[0];
}

function _getHeaderMap(aba) {
  const headers = aba.getRange(1, 1, 1, aba.getLastColumn()).getValues()[0];
  const map = {};
  headers.forEach((h, i) => {
    if (!h) return;
    const k = _removerAcentos(String(h)).toLowerCase().replace(/[\s_\-\.]/g,'');
    map[k] = i;
  });
  return { headers, map };
}

function _colIdx(map, aliases) {
  for (const alias of aliases) {
    const k = _removerAcentos(alias).toLowerCase().replace(/[\s_\-\.]/g,'');
    if (map[k] !== undefined) return map[k];
  }
  return -1;
}

function carregarLancamentosPlanilha(mesLabel) {
  const resultado = { perdas: {}, transf: {}, vendas_site: 0, fat_cd_transf: 0 };
  try {
    const ss  = _getPlanilhaLancamentos();
    const aba = _getAbaLancamentos(ss);
    const { map } = _getHeaderMap(aba);

    const iComp   = _colIdx(map, ALIASES_COMPETENCIA);
    const iFilial = _colIdx(map, ALIASES_FILIAL);
    const iPerdas = _colIdx(map, ALIASES_PERDAS);
    const iTransf = _colIdx(map, ALIASES_TRANSF);
    const iSite   = _colIdx(map, ALIASES_SITE);
    const iFatCD  = _colIdx(map, ALIASES_FAT_CD);

    if (iComp < 0 || iFilial < 0) {
      Logger.log('[Lanc] Colunas não mapeadas. Execute diagnosticarPlanilhaDB().');
      return resultado;
    }

    const dados = aba.getDataRange().getValues();
    for (let i = 1; i < dados.length; i++) {
      if (!_competenciaMatch(dados[i][iComp], mesLabel)) continue;
      const filialNorm = normalizarFilialGas(String(dados[i][iFilial]).trim());
      if (!filialNorm) continue;
      if (iPerdas >= 0) { const v = _parseNumGas(dados[i][iPerdas]); if (v) resultado.perdas[filialNorm] = (resultado.perdas[filialNorm]||0)+v; }
      if (iTransf >= 0) { const v = _parseNumGas(dados[i][iTransf]); if (v) resultado.transf[filialNorm] = (resultado.transf[filialNorm]||0)+v; }
      if (iSite   >= 0) { const v = _parseNumGas(dados[i][iSite]);   if (v) resultado.vendas_site += v; }
      if (iFatCD  >= 0) { const v = _parseNumGas(dados[i][iFatCD]);  if (v) resultado.fat_cd_transf += v; }
    }
    Logger.log('[Lanc] "'+mesLabel+'": ' + JSON.stringify(resultado));
    return resultado;
  } catch(e) {
    Logger.log('[Lanc] ERRO: ' + e.message);
    return resultado;
  }
}

function salvarLancamentosPlanilha(mes, lancamentosObj) {
  try {
    const ss  = _getPlanilhaLancamentos();
    const aba = _getAbaLancamentos(ss);
    const { headers, map } = _getHeaderMap(aba);
    const iComp   = _colIdx(map, ALIASES_COMPETENCIA);
    const iFilial = _colIdx(map, ALIASES_FILIAL);
    const iPerdas = _colIdx(map, ALIASES_PERDAS);
    const iTransf = _colIdx(map, ALIASES_TRANSF);
    const iSite   = _colIdx(map, ALIASES_SITE);
    const iFatCD  = _colIdx(map, ALIASES_FAT_CD);

    if (iComp < 0 || iFilial < 0) throw new Error('Colunas Competência/Filial não mapeadas.');

    const dados = aba.getDataRange().getValues();
    for (let i = dados.length - 1; i >= 1; i--) {
      if (_competenciaMatch(dados[i][iComp], mes)) aba.deleteRow(i + 1);
    }

    const mesTexto = String(mes).toUpperCase().trim();
    FILIAIS_ORDEM_GAS.forEach(filial => {
      const perdas = _parseNumGas(lancamentosObj.perdas?.[filial]);
      const transf = _parseNumGas(lancamentosObj.transf?.[filial]);
      const site   = filial === 'DUQUE'      ? _parseNumGas(lancamentosObj.vendas_site)    : 0;
      const fatCD  = filial === 'CD DELALE'  ? _parseNumGas(lancamentosObj.fat_cd_transf)  : 0;
      if (!perdas && !transf && !site && !fatCD) return;
      const linha = new Array(Math.max(headers.length, 5)).fill('');
      linha[iComp]   = mesTexto;
      linha[iFilial] = filial;
      if (iPerdas >= 0) linha[iPerdas] = perdas || '';
      if (iTransf >= 0) linha[iTransf] = transf || '';
      if (iSite   >= 0) linha[iSite]   = site   || '';
      if (iFatCD  >= 0) linha[iFatCD]  = fatCD  || '';
      aba.appendRow(linha);
    });

    return { sucesso: true };
  } catch(e) {
    throw new Error('Erro ao persistir lançamentos: ' + e.message);
  }
}

function diagnosticarPlanilhaDB() {
  try {
    const ss  = _getPlanilhaLancamentos();
    const aba = _getAbaLancamentos(ss);
    const { headers, map } = _getHeaderMap(aba);
    Logger.log('Planilha: "' + ss.getName() + '" | Aba: "' + aba.getName() + '"');
    Logger.log('Cabeçalhos: ' + JSON.stringify(headers));
    Logger.log('Competência → ' + _colIdx(map, ALIASES_COMPETENCIA));
    Logger.log('Filial      → ' + _colIdx(map, ALIASES_FILIAL));
    Logger.log('Perdas      → ' + _colIdx(map, ALIASES_PERDAS));
    Logger.log('Transf.     → ' + _colIdx(map, ALIASES_TRANSF));
    Logger.log('Vendas Site → ' + _colIdx(map, ALIASES_SITE));
    Logger.log('Fat. CD (Transf.) → ' + _colIdx(map, ALIASES_FAT_CD));
  } catch(e) { Logger.log('ERRO: ' + e.message); }
}