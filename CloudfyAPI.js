// ============================================================
// CARVO · Integração com a API do Cloudfy (somente leitura)
// ============================================================
// Endpoint único: POST https://api.cloudfy.net.br/ApiCFYCC
// As credenciais NUNCA ficam no código — leia/grave via Script Properties
// rodando configurarCredenciaisCloudfy() uma vez no editor.
//
// LIMITE DA API (imposto pelo Cloudfy, não é escolha nossa):
//   7 consultas/hora e 168/dia por Empresa+Filial+Consulta, e só nos
//   horários 00,01,04,07-11,14-16,21-23. Por isso NADA aqui é chamado
//   durante o uso do painel: um gatilho diário grava o resultado numa aba
//   de cache e o painel lê só o cache.
// ============================================================

var CFY_URL      = 'https://api.cloudfy.net.br/ApiCFYCC';
var CFY_ABA_CACHE = 'FICHAS_CLOUDFY';     // aba de cache (na planilha FICHAS_MANUAIS_SHEET_ID)
var CFY_HORAS_PERMITIDAS = [0, 1, 4, 7, 8, 9, 10, 11, 14, 15, 16, 21, 22, 23];

// ── Configuração (rodar UMA vez no editor, com os valores do arquivo de credenciais) ──
function configurarCredenciaisCloudfy(accKey, tokenKey, login, nomeUsr, codEmpresa, codFilial) {
  var p = PropertiesService.getScriptProperties();
  p.setProperties({
    CFY_ACCKEY:   String(accKey).trim(),
    CFY_TOKENKEY: String(tokenKey).trim(),
    CFY_LOGIN:    String(login).trim(),
    CFY_NOME:     String(nomeUsr).trim(),
    CFY_EMPRESA:  String(codEmpresa).trim(),
    CFY_FILIAL:   String(codFilial || 1).trim()
  });
  return 'Credenciais do Cloudfy gravadas nas Script Properties.';
}

function cfyCredenciais_() {
  var p = PropertiesService.getScriptProperties();
  var c = {
    accKey:   p.getProperty('CFY_ACCKEY'),
    tokenKey: p.getProperty('CFY_TOKENKEY'),
    login:    p.getProperty('CFY_LOGIN'),
    nome:     p.getProperty('CFY_NOME'),
    empresa:  Number(p.getProperty('CFY_EMPRESA')),
    filial:   Number(p.getProperty('CFY_FILIAL') || 1)
  };
  if (!c.accKey || !c.tokenKey) {
    throw new Error('Credenciais do Cloudfy não configuradas. Rode configurarCredenciaisCloudfy() no editor.');
  }
  return c;
}

// ── Chamada genérica ──
function cfyChamar_(apiName, filtros, codFilialOverride) {
  var c = cfyCredenciais_();
  var dados = {
    Solicitante: {
      LoginUsr: c.login, NomeUsr: c.nome,
      CodEmpresa: c.empresa,
      CodFilial: Number(codFilialOverride || c.filial)
    }
  };
  if (filtros) dados.Filtros = filtros;

  var resp = UrlFetchApp.fetch(CFY_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      Parameters: { AccKey: c.accKey, TokenKey: c.tokenKey, ApiName: apiName, Data: dados }
    }),
    muteHttpExceptions: true
  });

  if (resp.getResponseCode() !== 200) {
    throw new Error('Cloudfy ' + apiName + ': HTTP ' + resp.getResponseCode() + ' — ' + resp.getContentText().slice(0, 300));
  }
  var j = JSON.parse(resp.getContentText());
  var rs = j.ResultSet || {};
  if (String(rs.CodRet) !== '0') {
    throw new Error('Cloudfy ' + apiName + ': ' + (rs.MensagemRet || 'retorno de erro') + ' (CodRet ' + rs.CodRet + ')');
  }
  return rs;
}

// A API devolve algumas chaves com espaço sobrando no fim ('Unidade ', 'DescGrupo ').
function cfyCampo_(obj, nome) {
  return obj[nome] !== undefined ? obj[nome] : obj[nome + ' '];
}
function cfyTexto_(v) { return String(v === null || v === undefined ? '' : v).trim(); }

// ── CFYCC880: ficha técnica -> linhas no layout C_FICHAS (Dados.js) ──
// IMPORTANTE: quantidades e custos saem como NÚMERO, nunca string. numVal()
// trata ponto como separador de milhar (padrão brasileiro), então "0.125"
// viraria 125 se fosse gravado como texto.
function cfyFichaTecnicaLinhas_(codFilial) {
  var rs = cfyChamar_('CFYCC880', { CodGrupos: [], CodRefProdutos: [] }, codFilial);
  var prods = rs.Produtos || [];
  var linhas = [[
    'COD','PRODUTO','UND','TIPO','GRUPO','RENDIMENTO','CUSTO_UNIT','','','','',
    'COD_INSUMO','INSUMO','QTDE','UND_INSUMO','CUSTO_UNIT_INSUMO','CUSTO_TOTAL_INSUMO'
  ]];

  prods.forEach(function(p) {
    // O Cloudfy não expõe "Venda"/"Matéria prima" nessa consulta. O campo só
    // é guardado como rótulo (nenhum cálculo do painel lê ele), então a
    // heurística de preço de venda > 0 é suficiente.
    var base = [
      cfyTexto_(p.CodRefProduto),
      cfyTexto_(p.Produto),
      cfyTexto_(cfyCampo_(p, 'Unidade')),
      Number(cfyCampo_(p, 'VlrUnitario')) > 0 ? 'Venda' : 'Matéria prima',
      cfyTexto_(cfyCampo_(p, 'DescGrupo')),
      Number(p.Rendimento) || 1,
      Number(cfyCampo_(p, 'VlrCustoMedioUnit')) || 0,
      '', '', '', ''
    ];
    var insumos = p.Insumos || [];
    if (!insumos.length) {
      linhas.push(base.concat(['', '', '', '', '', '']));
      return;
    }
    // Só os insumos diretos: cada sub-receita já vem como ficha própria na
    // mesma resposta, e é assim que calcularCustoExplodido espera encontrar.
    insumos.forEach(function(i) {
      linhas.push(base.concat([
        cfyTexto_(i.CodRefProduto),
        cfyTexto_(i.Insumo),
        Number(i.Quantidade) || 0,
        cfyTexto_(cfyCampo_(i, 'Unidade')),
        Number(cfyCampo_(i, 'VlrCustoMedioUnit')) || 0,
        Number(i.VlrCustoTotal) || 0
      ]));
    });
  });

  return linhas;
}

// ── Gatilho diário: busca na API e grava no cache ──
function atualizarCacheFichas() {
  var hora = Number(Utilities.formatDate(new Date(), 'America/Belem', 'H'));
  if (CFY_HORAS_PERMITIDAS.indexOf(hora) === -1) {
    Logger.log('Fora da janela permitida pela API (hora ' + hora + '). Nada feito.');
    return { ok: false, erro: 'Fora da janela permitida pela API do Cloudfy (hora ' + hora + ').' };
  }

  try {
    var linhas = cfyFichaTecnicaLinhas_();
    if (linhas.length < 2) throw new Error('A API respondeu sem nenhuma ficha.');

    var ss  = obterFichasManuaisSheet_();   // mesma planilha das fichas manuais (id guardado em Script Properties)
    var aba = ss.getSheetByName(CFY_ABA_CACHE);
    if (!aba) aba = ss.insertSheet(CFY_ABA_CACHE);
    aba.clearContents();
    aba.getRange(1, 1, linhas.length, linhas[0].length).setValues(linhas);
    aba.getRange(1, 1, 1, linhas[0].length).setFontWeight('bold');

    PropertiesService.getScriptProperties().setProperty(
      'CFY_FICHAS_ATUALIZADO', Utilities.formatDate(new Date(), 'America/Belem', 'dd/MM/yyyy HH:mm')
    );
    SpreadsheetApp.flush();
    Logger.log('Cache de fichas atualizado: ' + (linhas.length - 1) + ' linhas.');
    return { ok: true, linhas: linhas.length - 1 };
  } catch (err) {
    // Falha não derruba nada: o painel continua lendo o cache anterior (ou o CSV).
    Logger.log('Falha ao atualizar cache de fichas: ' + err.message);
    return { ok: false, erro: err.message };
  }
}

function cfyLerCacheFichas_() {
  try {
    var ss  = obterFichasManuaisSheet_();
    var aba = ss.getSheetByName(CFY_ABA_CACHE);
    if (!aba || aba.getLastRow() < 2) return null;
    return aba.getRange(1, 1, aba.getLastRow(), 17).getValues();
  } catch (err) {
    Logger.log('Cache de fichas indisponível: ' + err.message);
    return null;
  }
}

// Data/hora da última atualização bem-sucedida (pra mostrar no painel).
function cfyFichasAtualizadoEm() {
  return PropertiesService.getScriptProperties().getProperty('CFY_FICHAS_ATUALIZADO') || '';
}

// ── Gatilho: roda todo dia às 8h (dentro da janela permitida) ──
function instalarGatilhoFichas() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'atualizarCacheFichas') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('atualizarCacheFichas').timeBased().atHour(8).everyDays(1).create();
  return 'Gatilho diário criado (8h).';
}
