// ============================================================
//  CacheProcessamento.gs — Cache de pacotes mensais + leitura/
//  conversão de arquivos (xlsx → Google Sheets → JSON)
//  (depende de Constantes.gs)
// ============================================================

// ─── CACHE ────────────────────────────────────────────────────────────────────
function _chaveCache(id) { return 'cmv_' + id; }

function _lerCache(id) {
  try {
    const cache = CacheService.getScriptCache();
    const chave = _chaveCache(id);
    const meta  = cache.get(chave + '_meta');
    if (!meta) return null;
    const chunks = parseInt(meta, 10);
    const partes = [];
    for (let i = 0; i < chunks; i++) {
      const p = cache.get(chave + '_' + i);
      if (p === null) return null;
      partes.push(p);
    }
    return JSON.parse(partes.join(''));
  } catch(e) { return null; }
}

function _gravarCache(id, pacote) {
  try {
    const cache   = CacheService.getScriptCache();
    const chave   = _chaveCache(id);
    const json    = JSON.stringify(pacote);
    const TAM     = 90000;
    const chunks  = Math.ceil(json.length / TAM);
    const LOTE    = 19;
    let lote = {}, count = 0;
    for (let i = 0; i < chunks; i++) {
      lote[chave + '_' + i] = json.substring(i * TAM, (i+1) * TAM);
      count++;
      if (count === LOTE) { cache.putAll(lote, CACHE_TTL); lote = {}; count = 0; }
    }
    lote[chave + '_meta'] = String(chunks);
    cache.putAll(lote, CACHE_TTL);
  } catch(e) { Logger.log('[Cache] Erro: ' + e.message); }
}

function invalidarCacheTudo() {
  try {
    const pastaRaiz = DriveApp.getFolderById(ID_PASTA_RAIZ);
    const subs = pastaRaiz.getFolders();
    while (subs.hasNext()) {
      const id    = subs.next().getId();
      const cache = CacheService.getScriptCache();
      const chave = _chaveCache(id);
      const meta  = cache.get(chave + '_meta');
      if (!meta) continue;
      const chunks = parseInt(meta, 10);
      const chaves = [chave + '_meta'];
      for (let i = 0; i < chunks; i++) chaves.push(chave + '_' + i);
      cache.removeAll(chaves);
    }
    return { sucesso: true };
  } catch(e) { return { erro: e.message }; }
}

// ─── PROCESSAMENTO DE ARQUIVOS ────────────────────────────────────────────────
function _processarArquivosDoPasta(idPastaMes) {
  const pastaMes = DriveApp.getFolderById(idPastaMes);
  const arquivos = pastaMes.getFiles();
  const pacote   = { ei:null, ef:null, compras:null, vendas:null, teorico:null, perdas:null, transferencias:null, produtosMestre:null, perdasCD:null };

  while (arquivos.hasNext()) {
    const arquivo = arquivos.next();
    const nome    = arquivo.getName().toLowerCase();
    const idArq   = arquivo.getId();
    try {
      if      (nome.includes('inicial'))                              pacote.ei      = converterExcelParaJSON(idArq,[['filial'],['custo total'],['tp. movto.','tp. movto']]);
      else if (nome.includes('final'))                                pacote.ef      = converterExcelParaJSON(idArq,[['filial'],['custo total'],['tp. movto.','tp. movto']]);
      else if (nome.includes('compras'))                              pacote.compras = converterExcelParaJSON(idArq,[['filial'],['total','valor total','custo total','total (r$)']]);
      else if (nome.includes('vendas'))                               pacote.vendas  = converterExcelParaJSON(idArq,[['filial','loja'],['total','valor total','faturamento'],['produto','item']]);
      else if (nome.includes('teorico')||nome.includes('teórico'))   pacote.teorico = converterExcelParaJSON(idArq,[['filial']]);
      else if (nome.includes('movimenta'))                            pacote.perdasCD = converterExcelParaJSON(idArq,[['filial'],['produto'],['tp. movto.','tp. movto'],['centro est.','centro est'],['custo total'],['data'],['grupo']]);
      else if (nome.includes('perdas'))                               pacote.perdas  = converterExcelParaJSON(idArq,[['filial'],['perdas em r$'],['motivo'],['produto']]);
      else if (nome.includes('transferenc'))                          pacote.transferencias = converterExcelParaJSON(idArq,[['filial'],['produto'],['tp. movto.','tp. movto'],['centro est.','centro est'],['custo unit.','custo unitario'],['custo total'],['data'],['cód. ref.','cod. ref.']]);
      else if (nome.includes('manuten'))                              pacote.produtosMestre = converterExcelParaJSON(idArq,[['cód. ref.','cod. ref.'],['custo médio','custo medio']]);
    } catch(e) {
      if (e.message.startsWith('MissingColumns:')) {
        throw new Error("Estrutura Inválida: '"+arquivo.getName()+"' — ["+e.message.split(':')[1]+"]");
      }
      throw e;
    }
  }
  return pacote;
}

function converterExcelParaJSON(idArquivo, colunasObrigatorias) {
  const arquivo = DriveApp.getFileById(idArquivo);
  return arquivo.getMimeType() === MIME_SHEETS
    ? _lerPlanilhaGoogleDireta(idArquivo, colunasObrigatorias)
    : _converterXlsxParaJSON(idArquivo, arquivo, colunasObrigatorias);
}

function _lerPlanilhaGoogleDireta(id, cols) {
  const ss  = SpreadsheetApp.openById(id);
  return _matrizParaObjetos(ss.getSheets()[0].getDataRange().getValues(), cols);
}

// ✅ FUNÇÃO CORRIGIDA PARA API v2 — com retry p/ atraso de propagação do Drive
function _converterXlsxParaJSON(idArq, arqObj, cols) {
  let tmpFileId = null;
  let tmpConvertedId = null;

  try {
    // Passo 1: Cria arquivo XLSX temporário no Drive
    const tmpName = 'tmp_cmv_' + Utilities.getUuid() + '.xlsx';
    const tmpFile = DriveApp.createFile(tmpName, arqObj.getBlob());
    tmpFileId = tmpFile.getId();

    Logger.log('[Conv] Arquivo temp criado: ' + tmpFileId);

    // Pequena espera pro Drive propagar o arquivo antes do copy (evita "Invalid JSON payload")
    Utilities.sleep(400);

    // Passo 2: Usa Drive API v2 para converter para Google Sheets (com retry)
    const resource = {
      title: tmpName.replace('.xlsx', ''),
      mimeType: MimeType.GOOGLE_SHEETS
    };

    let converted = null;
    let ultimoErro = null;
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      try {
        converted = Drive.Files.copy(resource, tmpFileId); // ordem correta: resource, depois fileId
        ultimoErro = null;
        break;
      } catch (e) {
        ultimoErro = e;
        Logger.log('[Conv] Tentativa ' + tentativa + ' falhou: ' + e.message);
        Utilities.sleep(700 * tentativa); // espera crescente entre tentativas
      }
    }
    if (ultimoErro) throw ultimoErro; // esgotou as tentativas, propaga o erro real

    tmpConvertedId = converted.id;
    Logger.log('[Conv] Arquivo convertido: ' + tmpConvertedId);

// Passo 3: Lê o Google Sheets convertido (com retry — evita ler antes do conteúdo propagar)
    let resultado = null;
    for (let tentativaLeitura = 1; tentativaLeitura <= 3; tentativaLeitura++) {
      const ss = SpreadsheetApp.openById(tmpConvertedId);
      const matriz = ss.getSheets()[0].getDataRange().getValues();
      const cabecalhoVazio = !matriz.length || matriz[0].every(c => c === '' || c === null || c === undefined);
      if (!cabecalhoVazio) {
        resultado = _matrizParaObjetos(matriz, cols);
        break;
      }
      Logger.log('[Conv] Cabeçalho vazio na tentativa ' + tentativaLeitura + ', aguardando propagação...');
      Utilities.sleep(600 * tentativaLeitura);
    }
    if (resultado === null) {
      throw new Error('Falha ao ler conteúdo do Sheets convertido após 3 tentativas (arquivo pode estar vazio ou corrompido)');
    }

    return resultado;

  } catch(e) {
    Logger.log('[Conv] ERRO: ' + e.message);
    throw e;

  } finally {
    // Limpeza: move para lixo (não deleta permanentemente)
    if (tmpFileId) {
      try { DriveApp.getFileById(tmpFileId).setTrashed(true); } catch(e2) {}
    }
    if (tmpConvertedId) {
      try { DriveApp.getFileById(tmpConvertedId).setTrashed(true); } catch(e2) {}
    }
  }
}

// Remove acentos (funciona independente de a string vir em NFC ou NFD)
function _semAcento(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function _matrizParaObjetos(matriz, colunasObrigatorias) {
  if (!matriz || !matriz.length) return [];
  const cabs = matriz[0].map(h =>
    _semAcento(h).toLowerCase().trim().replace(/\s+/g,' ').replace(/[\u00A0\u200B]/g,'')
  );
  if (colunasObrigatorias?.length > 0) {
    const faltantes = colunasObrigatorias.filter(g =>
      !g.some(s => cabs.indexOf(_semAcento(s).toLowerCase().trim().replace(/\s+/g,' ')) !== -1)
    ).map(g => g[0]);
    if (faltantes.length) throw new Error('MissingColumns:' + faltantes.join(', ') + ' | Cabeçalhos lidos = [' + cabs.join(' / ') + ']');
  }
  const lista = [];
  for (let i = 1; i < matriz.length; i++) {
    const linha = matriz[i]; let vazia = true; const obj = {};
    for (let j = 0; j < cabs.length; j++) {
      let v = linha[j];
      if (v instanceof Date) v = v.toISOString();
      if (typeof v === 'string') v = v.trim().replace(/[\u00A0\u200B]/g,'');
      obj[cabs[j]] = v;
      if (v !== '' && v !== null && v !== undefined) vazia = false;
    }
    if (!vazia) lista.push(obj);
  }
  return lista;
}