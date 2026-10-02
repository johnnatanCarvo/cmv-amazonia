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

// ── Teste de conexão: usa a consulta mais barata (lista de filiais) e
// ESTOURA o erro em vez de engolir, pra diagnóstico no editor. ──
function testarConexaoCloudfy() {
  var rs = cfyChamar_('CFYCC882', null);
  var filiais = (rs.Filiais || []).map(function(f) { return f.NrFilial + ' = ' + f.Filial; });
  var msg = 'Conexão OK. ' + filiais.length + ' filiais: ' + filiais.join(' | ');
  Logger.log(msg);
  return msg;
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

// ============================================================
// COMPRAS (CFYCC892)
// ============================================================
// Só o MÊS CORRENTE vem da API. Janeiro..mês anterior continuam nos CSVs
// exportados à mão, que já estão fechados e completos -- reimportar o passado
// seria risco sem ganho. O problema que isso resolve é só do mês em aberto,
// onde a exportação manual atrasa (em setembro/2026 o CSV parou no dia 18 e
// ainda tinha dias parciais antes disso).
var CFY_ABA_COMPRAS = 'COMPRAS_CLOUDFY';
var CFY_FILIAIS_COMPRA = [
  { nr: 1, nome: 'UMARIZAL' },
  { nr: 2, nome: 'MARCO' },
  { nr: 3, nome: 'PORTO FUTURO' }
  // filial 4 (ACAI NA CUIA) não registra compras -- conferido na API
];

// Mapa código -> grupo do produto. A consulta de compras NÃO devolve o grupo,
// e ele alimenta CMC por grupo e Curva ABC. Montado a partir do cache de
// fichas (produtos e insumos) e completado pelo histórico de compras dos CSVs.
// Cobertura medida em setembro/2026: 99,98% do valor comprado.
function cfyMapaGrupos_(rowsComprasCSV) {
  var mapa = {};
  var fichas = cfyLerCacheFichas_();
  if (fichas) {
    for (var i = 1; i < fichas.length; i++) {
      var codProd = String(fichas[i][0] || '').trim();
      var grpProd = String(fichas[i][4] || '').trim();
      if (codProd && grpProd && !mapa[codProd]) mapa[codProd] = grpProd;
    }
  }
  if (rowsComprasCSV) {
    for (var j = 1; j < rowsComprasCSV.length; j++) {
      var r = rowsComprasCSV[j];
      var cod = String(r[C_COMPRAS.cod] || '').trim();
      var grp = String(r[C_COMPRAS.grupo] || '').trim();
      if (cod && grp && !mapa[cod]) mapa[cod] = grp;
    }
  }
  return mapa;
}

// CFYCC892 -> linhas no layout C_COMPRAS.
// Sem filtro de situação/integração: conferido contra o CSV, filtrar por
// IntegCompra descartava compra real (R$ 10 mil só em Umarizal, setembro).
function cfyComprasLinhas_(codFilial, nomeFilial, dataIni, dataFim, mapaGrupos) {
  var rs = cfyChamar_('CFYCC892', {
    DataInicio: dataIni, DataFim: dataFim,
    CodFornecedor: null, CPFCNPJFornecedor: null, NrDoc: null, ChaveNF: null,
    // IdentifConsultaCobrancas só aceita 0 ou 1 — e 1 é o valor com que a
    // conferência contra o CSV foi feita. Não mexer sem refazer a conferência.
    IdentifConsultaItens: 1, IdentifConsultaCobrancas: 1
  }, codFilial);

  var linhas = [];
  var naoIntegrados = 0, valorNaoIntegrado = 0;
  (rs.Compras || []).forEach(function(c) {
    var s = String(c.DataCompra);
    var dataBR = s.slice(6, 8) + '/' + s.slice(4, 6) + '/' + s.slice(0, 4);
    (c.Itens || []).forEach(function(i) {
      // Os campos "Integrado" são os do catálogo interno. ItemCompra traz o
      // nome que veio na nota do fornecedor ("OLEO DE ALGODAO; BALDE 1" em vez
      // de "MP OLEO DE ALGODAO") e não casa com ficha técnica nem com estoque.
      // Item ainda não integrado ao catálogo (NFe importada mas não conciliada):
      // vem sem CodRefIntegrado e sem QtdIntegrada. Entra como R$ 0 e com a
      // descrição da nota ("ALCOOL ETIL SOL 46.2 INPM LIMPADOR 1L UNIDADE QTD.
      // 1.00 UN"), que não casa com ficha nem com estoque. Fica de fora -- é o
      // mesmo critério do relatório do Cloudfy, conferido contra o CSV.
      // Assim que alguém integrar no Cloudfy, a próxima execução traz o item,
      // porque o mês inteiro é rebuscado todo dia.
      var cod = cfyTexto_(i.CodRefIntegrado);
      if (!cod) {
        naoIntegrados++;
        valorNaoIntegrado += Number(i['Valor total']) || 0;
        return;
      }
      var produto = cfyTexto_(i.ProdutoIntegrado);
      var qtd     = Number(i.QtdIntegrada) || 0;
      var unit    = Number(i.VlrUnitIntegrado) || 0;
      if (!produto) return;
      var linha = new Array(18);
      for (var k = 0; k < 18; k++) linha[k] = '';
      linha[C_COMPRAS.filial]      = nomeFilial;
      linha[C_COMPRAS.data]        = dataBR;
      linha[C_COMPRAS_FORNECEDOR]  = cfyTexto_(c.Fornecedor);
      linha[C_COMPRAS.cod]         = cod;
      linha[C_COMPRAS.produto]     = produto;
      linha[C_COMPRAS.grupo]       = mapaGrupos[cod] || '';
      linha[C_COMPRAS.qtd]         = qtd;
      linha[C_COMPRAS.unid]        = cfyTexto_(i.UndMedidaIntegrado || i.UndMedidaCompra);
      linha[C_COMPRAS.custo_atual] = unit;
      linha[C_COMPRAS.total]       = qtd * unit;
      linhas.push(linha);
    });
  });
  if (naoIntegrados) {
    Logger.log('  ' + nomeFilial + ': ' + naoIntegrados + ' itens fora (sem integração no Cloudfy), R$ ' + valorNaoIntegrado.toFixed(2));
  }
  PropertiesService.getScriptProperties().setProperty(
    'CFY_NAO_INTEGRADO_' + codFilial, naoIntegrados + '|' + valorNaoIntegrado.toFixed(2)
  );
  return linhas;
}

// Quanto de compra está parado sem integração no Cloudfy, por filial.
// Esse valor não entra no CMC de ninguém -- nem do painel, nem do Cloudfy --
// até alguém conciliar a nota com o catálogo de produtos.
function cfyComprasNaoIntegradas() {
  var props = PropertiesService.getScriptProperties();
  var fora = [];
  CFY_FILIAIS_COMPRA.forEach(function(f) {
    var v = props.getProperty('CFY_NAO_INTEGRADO_' + f.nr);
    if (!v) return;
    var p = v.split('|');
    if (Number(p[0]) > 0) fora.push({ filial: f.nome, itens: Number(p[0]), valor: Number(p[1]) });
  });
  return fora;
}

// Gatilho diário: puxa o mês corrente das 3 filiais e grava no cache.
function atualizarCacheCompras() {
  var hora = Number(Utilities.formatDate(new Date(), 'America/Belem', 'H'));
  if (CFY_HORAS_PERMITIDAS.indexOf(hora) === -1) {
    Logger.log('Fora da janela permitida pela API (hora ' + hora + '). Nada feito.');
    return { ok: false, erro: 'Fora da janela permitida pela API do Cloudfy.' };
  }
  try {
    var hoje = new Date();
    var ano  = Number(Utilities.formatDate(hoje, 'America/Belem', 'yyyy'));
    var mes  = Number(Utilities.formatDate(hoje, 'America/Belem', 'MM'));
    var dia  = Number(Utilities.formatDate(hoje, 'America/Belem', 'dd'));
    var ini  = ano * 10000 + mes * 100 + 1;
    var fim  = ano * 10000 + mes * 100 + dia;

    var mapaGrupos = cfyMapaGrupos_(lerTodosCSVs('compras'));
    var todas = [];
    CFY_FILIAIS_COMPRA.forEach(function(f) {
      todas = todas.concat(cfyComprasLinhas_(f.nr, f.nome, ini, fim, mapaGrupos));
    });
    if (!todas.length) throw new Error('A API não devolveu nenhuma compra do mês corrente.');

    var cab = new Array(18);
    for (var k = 0; k < 18; k++) cab[k] = 'C' + k;
    cab[C_COMPRAS.filial] = 'FILIAL'; cab[C_COMPRAS.data] = 'DATA';
    cab[C_COMPRAS_FORNECEDOR] = 'FORNECEDOR'; cab[C_COMPRAS.cod] = 'COD';
    cab[C_COMPRAS.produto] = 'PRODUTO'; cab[C_COMPRAS.grupo] = 'GRUPO';
    cab[C_COMPRAS.qtd] = 'QTD'; cab[C_COMPRAS.unid] = 'UND';
    cab[C_COMPRAS.custo_atual] = 'CUSTO_UNIT'; cab[C_COMPRAS.total] = 'TOTAL';

    var ss  = obterFichasManuaisSheet_();
    var aba = ss.getSheetByName(CFY_ABA_COMPRAS);
    if (!aba) aba = ss.insertSheet(CFY_ABA_COMPRAS);
    aba.clearContents();
    var dados = [cab].concat(todas);
    aba.getRange(1, 1, dados.length, 18).setValues(dados);
    aba.getRange(1, 1, 1, 18).setFontWeight('bold');

    PropertiesService.getScriptProperties().setProperties({
      CFY_COMPRAS_MES: pad2(mes) + '/' + ano,
      CFY_COMPRAS_ATUALIZADO: Utilities.formatDate(hoje, 'America/Belem', 'dd/MM/yyyy HH:mm')
    });
    SpreadsheetApp.flush();
    Logger.log('Cache de compras atualizado: ' + todas.length + ' linhas (' + pad2(mes) + '/' + ano + ').');
    return { ok: true, linhas: todas.length };
  } catch (err) {
    Logger.log('Falha ao atualizar cache de compras: ' + err.message);
    return { ok: false, erro: err.message };
  }
}

function cfyLerCacheCompras_() {
  try {
    var ss  = obterFichasManuaisSheet_();
    var aba = ss.getSheetByName(CFY_ABA_COMPRAS);
    if (!aba || aba.getLastRow() < 2) return null;
    return {
      linhas: aba.getRange(2, 1, aba.getLastRow() - 1, 18).getValues(),
      mesRef: PropertiesService.getScriptProperties().getProperty('CFY_COMPRAS_MES') || ''
    };
  } catch (err) {
    Logger.log('Cache de compras indisponível: ' + err.message);
    return null;
  }
}

function cfyComprasAtualizadoEm() {
  return PropertiesService.getScriptProperties().getProperty('CFY_COMPRAS_ATUALIZADO') || '';
}

// ── Gatilho: roda todo dia às 8h (dentro da janela permitida) ──
function instalarGatilhoFichas() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'atualizarCacheFichas') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('atualizarCacheFichas').timeBased().atHour(8).everyDays(1).create();
  return 'Gatilho diário criado (8h).';
}

// Compras roda às 9h, uma hora depois das fichas: o mapa de grupos usa o cache
// de fichas, então ele precisa estar atualizado antes.
function instalarGatilhoCompras() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'atualizarCacheCompras') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('atualizarCacheCompras').timeBased().atHour(9).everyDays(1).create();
  return 'Gatilho diário de compras criado (9h).';
}
