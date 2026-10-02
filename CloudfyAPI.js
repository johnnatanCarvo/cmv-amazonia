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

// Data lida do cache: a planilha converte "01/09/2026" em Date de verdade na
// gravação, e aí volta como objeto, não string. Quem fizer slice() direto pega
// "ep" em vez de "09" e o mês inteiro deixa de ser reconhecido -- foi assim que
// o cache de compras virou invisível pro painel. Normaliza sempre.
function cfyDataBR_(v) {
  // Checa pelo método em vez de instanceof: data vinda de outro contexto de
  // execução não passa no instanceof, e aí voltaria "Tue Sep 01" em silêncio.
  if (v && typeof v.getMonth === 'function') {
    return Utilities.formatDate(v, 'America/Belem', 'dd/MM/yyyy');
  }
  return String(v === null || v === undefined ? '' : v).trim().slice(0, 10);
}

// Marca a coluna de data como texto puro antes de gravar, pra planilha parar de
// converter. Vale pros dois caches (compras e vendas).
function cfyFormatarColunaData_(aba, colData, nLinhas) {
  try {
    aba.getRange(2, colData + 1, Math.max(nLinhas, 1), 1).setNumberFormat('@');
  } catch (e) {
    Logger.log('Não consegui formatar a coluna de data como texto: ' + e.message);
  }
}

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

// Fornecedores que já tiveram compra conciliada como estoque. Serve pra separar,
// entre as notas pendentes, o que é insumo do que é ativo imobilizado/serviço.
// Ativo não entra em CMC nem CMV, então contar tudo junto superestimaria a
// pendência -- em setembro/2026 eram R$ 112 mil de equipamento (parque infantil,
// freezer, cabeçote de refrigeração) contra R$ 58 mil de insumo de verdade.
// Baseado no histórico e não numa lista fixa: fornecedor novo de alimento se
// classifica sozinho assim que tiver a primeira nota conciliada.
function cfyFornecedoresConhecidos_(rowsComprasCSV) {
  var set = {};
  (rowsComprasCSV || []).slice(1).forEach(function(r) {
    var f = String(r[C_COMPRAS_FORNECEDOR] || '').trim().toUpperCase().replace(/\s+/g, ' ');
    if (f) set[f] = true;
  });
  return set;
}

// CFYCC892 -> linhas no layout C_COMPRAS.
// Sem filtro de situação/integração: conferido contra o CSV, filtrar por
// IntegCompra descartava compra real (R$ 10 mil só em Umarizal, setembro).
function cfyComprasLinhas_(codFilial, nomeFilial, dataIni, dataFim, mapaGrupos, acumulador, fornConhecidos) {
  var rs = cfyChamar_('CFYCC892', {
    DataInicio: dataIni, DataFim: dataFim,
    CodFornecedor: null, CPFCNPJFornecedor: null, NrDoc: null, ChaveNF: null,
    // IdentifConsultaCobrancas só aceita 0 ou 1 — e 1 é o valor com que a
    // conferência contra o CSV foi feita. Não mexer sem refazer a conferência.
    IdentifConsultaItens: 1, IdentifConsultaCobrancas: 1
  }, codFilial);

  var linhas = [];
  var naoIntegrados = 0, valorInsumo = 0, valorOutros = 0;
  (rs.Compras || []).forEach(function(c) {
    var s = String(c.DataCompra);
    var dataBR = s.slice(6, 8) + '/' + s.slice(4, 6) + '/' + s.slice(0, 4);
    var fornecedor = String(c.Fornecedor || '').trim().toUpperCase().replace(/\s+/g, ' ');
    var pareceInsumo = !fornConhecidos || !!fornConhecidos[fornecedor];
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
        if (pareceInsumo) valorInsumo += Number(i['Valor total']) || 0;
        else              valorOutros += Number(i['Valor total']) || 0;
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
    Logger.log('  ' + nomeFilial + ': ' + naoIntegrados + ' itens sem conciliação — insumo R$ ' +
               valorInsumo.toFixed(2) + ', não-estoque R$ ' + valorOutros.toFixed(2));
  }
  // Quem chamou acumula por mês -- o aviso no painel só aparece no mês a que
  // pertence, senão quem está olhando setembro veria pendência de outubro.
  if (acumulador && (valorInsumo > 0 || valorOutros > 0)) {
    acumulador.push({
      filial: nomeFilial, itens: naoIntegrados,
      valor: Number(valorInsumo.toFixed(2)),         // o que de fato falta no CMC
      outros: Number(valorOutros.toFixed(2))         // ativo/serviço: não entra em CMC nem CMV
    });
  }
  return linhas;
}

// Quanto de compra está parado sem integração no Cloudfy, por mês e filial.
// Esse valor não entra no CMC de ninguém -- nem do painel, nem do Cloudfy --
// até alguém conciliar a nota com o catálogo de produtos.
// Formato: { 'OUTUBRO': [{filial, itens, valor}], ... }
function cfyComprasNaoIntegradas() {
  try {
    var bruto = PropertiesService.getScriptProperties().getProperty('CFY_NAO_INTEGRADO');
    return bruto ? JSON.parse(bruto) : {};
  } catch (err) {
    return {};
  }
}

// Gatilho diário: puxa o mês corrente E o anterior das 3 filiais.
//
// O cache ACUMULA: cada execução reescreve só as linhas dos meses buscados e
// preserva as dos demais. É isso que permite parar de exportar CSV -- a partir
// de outubro/2026 o cache é o registro definitivo de compras. Se ele apagasse
// tudo a cada execução, na virada do mês o mês que acabou sumiria, já que não
// haveria CSV dele.
//
// O mês anterior entra junto porque nota lançada com atraso continua chegando
// depois da virada; buscar os dois cobre isso sem depender de ninguém.
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

    var anoAnt = mes === 1 ? ano - 1 : ano;
    var mesAnt = mes === 1 ? 12 : mes - 1;
    var ultimoDiaAnt = new Date(anoAnt, mesAnt, 0).getDate();

    // [início, fim, rótulo MM/yyyy] -- o limite da consulta é 31 dias, então
    // um mês inteiro cabe numa chamada.
    //
    // O mês anterior só é rebuscado até o dia 10. Depois disso ele já fechou:
    // nota atrasada praticamente não chega mais, e continuar rebuscando só
    // gastaria chamada e deixaria um número fechado mudando sozinho. Como o
    // cache acumula, o que foi gravado até o dia 10 fica congelado lá.
    var janelas = [];
    if (dia <= 10) {
      janelas.push({ ini: anoAnt * 10000 + mesAnt * 100 + 1, fim: anoAnt * 10000 + mesAnt * 100 + ultimoDiaAnt,
                     ref: pad2(mesAnt) + '/' + anoAnt, nome: NOMES_MESES[mesAnt] });
    }
    janelas.push({ ini: ano * 10000 + mes * 100 + 1, fim: ano * 10000 + mes * 100 + dia,
                   ref: pad2(mes) + '/' + ano, nome: NOMES_MESES[mes] });

    var rowsCSV     = lerTodosCSVs('compras');
    var mapaGrupos  = cfyMapaGrupos_(rowsCSV);
    var fornecedores = cfyFornecedoresConhecidos_(rowsCSV);
    var todas = [], mesesBuscados = {}, naoIntegradoPorMes = {};
    janelas.forEach(function(j) {
      mesesBuscados[j.ref] = true;
      var acum = [];
      CFY_FILIAIS_COMPRA.forEach(function(f) {
        todas = todas.concat(cfyComprasLinhas_(f.nr, f.nome, j.ini, j.fim, mapaGrupos, acum, fornecedores));
      });
      if (acum.length) naoIntegradoPorMes[j.nome] = acum;
    });
    if (!todas.length) throw new Error('A API não devolveu nenhuma compra nos dois meses buscados.');

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

    // Preserva o que já está no cache de meses que não foram buscados agora.
    var preservadas = [];
    if (aba.getLastRow() > 1) {
      aba.getRange(2, 1, aba.getLastRow() - 1, 18).getValues().forEach(function(r) {
        var d = cfyDataBR_(r[C_COMPRAS.data]);
        if (d.length < 10) return;
        r[C_COMPRAS.data] = d;   // regrava normalizado
        var ref = d.slice(3, 5) + '/' + d.slice(6, 10);
        if (!mesesBuscados[ref]) preservadas.push(r);
      });
    }

    var dados = [cab].concat(preservadas).concat(todas);
    aba.clearContents();
    cfyFormatarColunaData_(aba, C_COMPRAS.data, dados.length);
    aba.getRange(1, 1, dados.length, 18).setValues(dados);
    aba.getRange(1, 1, 1, 18).setFontWeight('bold');

    PropertiesService.getScriptProperties().setProperties({
      CFY_COMPRAS_ATUALIZADO: Utilities.formatDate(hoje, 'America/Belem', 'dd/MM/yyyy HH:mm'),
      CFY_NAO_INTEGRADO: JSON.stringify(naoIntegradoPorMes)
    });
    SpreadsheetApp.flush();
    Logger.log('Cache de compras atualizado: ' + todas.length + ' linhas novas em ' +
               Object.keys(mesesBuscados).join(' e ') + ', ' + preservadas.length + ' preservadas de meses anteriores.');
    return { ok: true, linhas: todas.length, preservadas: preservadas.length };
  } catch (err) {
    Logger.log('Falha ao atualizar cache de compras: ' + err.message);
    return { ok: false, erro: err.message };
  }
}

// Devolve as linhas do cache e QUAIS meses ele cobre, deduzidos das próprias
// linhas -- não de uma propriedade à parte, que sairia do ar se alguém mexesse
// na aba à mão.
function cfyLerCacheCompras_() {
  try {
    var ss  = obterFichasManuaisSheet_();
    var aba = ss.getSheetByName(CFY_ABA_COMPRAS);
    if (!aba || aba.getLastRow() < 2) return null;
    var linhas = aba.getRange(2, 1, aba.getLastRow() - 1, 18).getValues();
    var meses = {};
    linhas.forEach(function(r) {
      var d = cfyDataBR_(r[C_COMPRAS.data]);
      r[C_COMPRAS.data] = d;   // o painel espera dd/MM/yyyy como texto
      if (d.length >= 10) meses[d.slice(3, 5) + '/' + d.slice(6, 10)] = true;
    });
    return { linhas: linhas, meses: meses };
  } catch (err) {
    Logger.log('Cache de compras indisponível: ' + err.message);
    return null;
  }
}

function cfyComprasAtualizadoEm() {
  return PropertiesService.getScriptProperties().getProperty('CFY_COMPRAS_ATUALIZADO') || '';
}

// ============================================================
// VENDAS (CFYCC870 — cupons)
// ============================================================
// Não existe consulta de vendas por produto na API: o resumo (CFYCC891) é por
// forma de pagamento. A fonte é o cupom, agregado por dia+produto, que é o
// formato que o painel já consome (C_VENDAS).
//
// A consulta aceita no máximo 3 DIAS por chamada, então o gatilho busca uma
// janela curta todo dia e o cache vai se formando. Conferido contra o CSV em
// 01-03/09 (Umarizal): bate ao centavo, R$ 75.698,37 dos dois lados.
var CFY_ABA_VENDAS = 'VENDAS_CLOUDFY';
var CFY_DIAS_VENDAS = 3;   // limite da própria consulta

function cfyVendasLinhas_(codFilial, nomeFilial, dataIni, dataFim) {
  var rs = cfyChamar_('CFYCC870', {
    DataInicio: dataIni, DataFim: dataFim,
    SituacaoCupom: 1, IdentifDesconto: 1, IdentifTaxaServico: 1,
    IdentifConsultaProd: 1, IdentifConsultaFormaPagto: 1,
    IdentifConsultaProdCancelados: 2
  }, codFilial);

  // agrega cupom -> dia + produto
  var mapa = {};
  (rs.CuponsVenda || []).forEach(function(c) {
    if (String(c.DescSituacao || '') !== 'Finalizado') return;
    var s = String(c.DataMovimento);
    var dataBR = s.slice(6, 8) + '/' + s.slice(4, 6) + '/' + s.slice(0, 4);
    (c.Produtos || []).forEach(function(p) {
      if (String(p.DescSituacaoItem || '') !== 'Finalizado') return;
      var nome = cfyTexto_(p.DescProduto);
      if (!nome) return;
      var chave = dataBR + '|' + nome;
      if (!mapa[chave]) {
        mapa[chave] = { data: dataBR, produto: nome, grupo: cfyTexto_(p.DescGrupo), qtd: 0, valor: 0 };
      }
      mapa[chave].qtd   += Number(p.Qtde) || 0;
      // VlrTotalLiq já é líquido de desconto; é o que o CSV traz na coluna Total.
      mapa[chave].valor += Number(p.VlrTotalLiq || p.VlrTotal) || 0;
    });
  });

  return Object.keys(mapa).map(function(k) {
    var v = mapa[k];
    var linha = new Array(15);
    for (var i = 0; i < 15; i++) linha[i] = '';
    linha[C_VENDAS.filial]  = nomeFilial;
    linha[C_VENDAS.data]    = v.data;
    linha[C_VENDAS.produto] = v.produto;
    linha[C_VENDAS.grupo]   = v.grupo;
    linha[C_VENDAS.qtd]     = v.qtd;
    linha[C_VENDAS.valor]   = v.valor;
    return linha;
  });
}

// Gatilho diário: busca os últimos dias e acumula no cache.
// A janela recua CFY_DIAS_VENDAS dias para pegar cupom reaberto ou ajustado
// depois do fechamento do caixa.
function atualizarCacheVendas() {
  var hora = Number(Utilities.formatDate(new Date(), 'America/Belem', 'H'));
  if (CFY_HORAS_PERMITIDAS.indexOf(hora) === -1) {
    Logger.log('Fora da janela permitida pela API (hora ' + hora + '). Nada feito.');
    return { ok: false, erro: 'Fora da janela permitida pela API do Cloudfy.' };
  }
  try {
    var hoje = new Date();
    var ini  = new Date(hoje.getTime() - (CFY_DIAS_VENDAS - 1) * 86400000);
    var fmt  = function(d) { return Number(Utilities.formatDate(d, 'America/Belem', 'yyyyMMdd')); };
    var fmtBR = function(d) { return Utilities.formatDate(d, 'America/Belem', 'dd/MM/yyyy'); };

    var diasBuscados = {};
    for (var k = 0; k < CFY_DIAS_VENDAS; k++) {
      diasBuscados[fmtBR(new Date(ini.getTime() + k * 86400000))] = true;
    }

    var todas = [];
    CFY_FILIAIS_COMPRA.forEach(function(f) {
      todas = todas.concat(cfyVendasLinhas_(f.nr, f.nome, fmt(ini), fmt(hoje)));
    });

    var ss  = obterFichasManuaisSheet_();
    var aba = ss.getSheetByName(CFY_ABA_VENDAS);
    if (!aba) aba = ss.insertSheet(CFY_ABA_VENDAS);

    // Acumula: preserva os dias que não foram buscados agora.
    var preservadas = [];
    if (aba.getLastRow() > 1) {
      aba.getRange(2, 1, aba.getLastRow() - 1, 15).getValues().forEach(function(r) {
        var d = cfyDataBR_(r[C_VENDAS.data]);
        r[C_VENDAS.data] = d;
        if (d && !diasBuscados[d]) preservadas.push(r);
      });
    }

    var cab = new Array(15);
    for (var i = 0; i < 15; i++) cab[i] = 'C' + i;
    cab[C_VENDAS.filial] = 'FILIAL'; cab[C_VENDAS.data] = 'DATA';
    cab[C_VENDAS.produto] = 'PRODUTO'; cab[C_VENDAS.grupo] = 'GRUPO';
    cab[C_VENDAS.qtd] = 'QTD'; cab[C_VENDAS.valor] = 'VALOR';

    var dados = [cab].concat(preservadas).concat(todas);
    aba.clearContents();
    cfyFormatarColunaData_(aba, C_VENDAS.data, dados.length);
    aba.getRange(1, 1, dados.length, 15).setValues(dados);
    aba.getRange(1, 1, 1, 15).setFontWeight('bold');

    PropertiesService.getScriptProperties().setProperty(
      'CFY_VENDAS_ATUALIZADO', Utilities.formatDate(hoje, 'America/Belem', 'dd/MM/yyyy HH:mm')
    );
    SpreadsheetApp.flush();
    Logger.log('Cache de vendas atualizado: ' + todas.length + ' linhas em ' +
               Object.keys(diasBuscados).join(', ') + ', ' + preservadas.length + ' preservadas.');
    return { ok: true, linhas: todas.length, preservadas: preservadas.length };
  } catch (err) {
    Logger.log('Falha ao atualizar cache de vendas: ' + err.message);
    return { ok: false, erro: err.message };
  }
}

// Preenche dias que o gatilho ainda não cobriu (ex: começo do mês corrente).
// Roda de trás pra frente a partir de hoje, em blocos de 3 dias, respeitando o
// limite de 7 consultas/hora por filial -- por isso no máximo 2 blocos por vez.
function backfillVendas(blocos) {
  var n = Number(blocos) || 2;
  var hoje = new Date();
  var feitos = [];
  for (var b = 0; b < n; b++) {
    var fim = new Date(hoje.getTime() - (b * CFY_DIAS_VENDAS + CFY_DIAS_VENDAS) * 86400000);
    var ini = new Date(fim.getTime() - (CFY_DIAS_VENDAS - 1) * 86400000);
    var r = cfyVendasPeriodo_(ini, fim);
    feitos.push(r);
  }
  return feitos;
}

function cfyVendasPeriodo_(ini, fim) {
  var fmt = function(d) { return Number(Utilities.formatDate(d, 'America/Belem', 'yyyyMMdd')); };
  var fmtBR = function(d) { return Utilities.formatDate(d, 'America/Belem', 'dd/MM/yyyy'); };
  var dias = {};
  for (var d = new Date(ini); d <= fim; d = new Date(d.getTime() + 86400000)) dias[fmtBR(d)] = true;

  var todas = [];
  CFY_FILIAIS_COMPRA.forEach(function(f) {
    todas = todas.concat(cfyVendasLinhas_(f.nr, f.nome, fmt(ini), fmt(fim)));
  });

  var ss  = obterFichasManuaisSheet_();
  var aba = ss.getSheetByName(CFY_ABA_VENDAS);
  if (!aba) { Logger.log('Rode atualizarCacheVendas() antes.'); return 'cache ainda não existe'; }
  var preservadas = [];
  aba.getRange(2, 1, Math.max(aba.getLastRow() - 1, 1), 15).getValues().forEach(function(r) {
    var dd = cfyDataBR_(r[C_VENDAS.data]);
    r[C_VENDAS.data] = dd;
    if (dd && !dias[dd]) preservadas.push(r);
  });
  var cab = aba.getRange(1, 1, 1, 15).getValues()[0];
  var dados = [cab].concat(preservadas).concat(todas);
  aba.clearContents();
  cfyFormatarColunaData_(aba, C_VENDAS.data, dados.length);
  aba.getRange(1, 1, dados.length, 15).setValues(dados);
  SpreadsheetApp.flush();
  var msg = fmtBR(ini) + ' a ' + fmtBR(fim) + ': ' + todas.length + ' linhas';
  Logger.log('Backfill de vendas -> ' + msg);
  return msg;
}

function cfyLerCacheVendas_() {
  try {
    var ss  = obterFichasManuaisSheet_();
    var aba = ss.getSheetByName(CFY_ABA_VENDAS);
    if (!aba || aba.getLastRow() < 2) return null;
    var linhas = aba.getRange(2, 1, aba.getLastRow() - 1, 15).getValues();
    var dias = {};
    linhas.forEach(function(r) {
      var d = cfyDataBR_(r[C_VENDAS.data]);
      r[C_VENDAS.data] = d;   // o painel espera dd/MM/yyyy como texto
      if (d) dias[d] = true;
    });
    return { linhas: linhas, dias: dias };
  } catch (err) {
    Logger.log('Cache de vendas indisponível: ' + err.message);
    return null;
  }
}

function cfyVendasAtualizadoEm() {
  return PropertiesService.getScriptProperties().getProperty('CFY_VENDAS_ATUALIZADO') || '';
}

// ── COBERTURA: o que já veio da API e o que ainda depende do CSV ──
// Vendas chegam em blocos de 3 dias, então a cobertura é irregular até o
// backfill terminar. Sem isso na tela, um mês pela metade passa por completo.
function cfyCobertura() {
  var out = { compras: [], vendas: [] };
  try {
    var cc = cfyLerCacheCompras_();
    if (cc) out.compras = Object.keys(cc.meses).sort(function(a, b) {
      return (a.slice(3) + a.slice(0, 2)).localeCompare(b.slice(3) + b.slice(0, 2));
    });
  } catch (e) {}
  try {
    var cv = cfyLerCacheVendas_();
    if (cv) {
      // agrupa os dias por mês: { '09/2026': [1,2,3...] }
      var porMes = {};
      Object.keys(cv.dias).forEach(function(d) {
        var ref = d.slice(3, 5) + '/' + d.slice(6, 10);
        if (!porMes[ref]) porMes[ref] = [];
        porMes[ref].push(Number(d.slice(0, 2)));
      });
      out.vendas = Object.keys(porMes).sort().map(function(ref) {
        var dias = porMes[ref].sort(function(a, b) { return a - b; });
        var mesNum = Number(ref.slice(0, 2)), anoNum = Number(ref.slice(3));
        var diasNoMes = new Date(anoNum, mesNum, 0).getDate();
        var hoje = new Date();
        var limite = (mesNum === hoje.getMonth() + 1 && anoNum === hoje.getFullYear())
          ? Number(Utilities.formatDate(hoje, 'America/Belem', 'dd')) : diasNoMes;
        var faltam = [];
        for (var d2 = 1; d2 <= limite; d2++) if (dias.indexOf(d2) === -1) faltam.push(d2);
        return { mes: NOMES_MESES[mesNum], ref: ref, temDias: dias.length, deDias: limite, faltam: faltam.length };
      });
    }
  } catch (e) {}
  return out;
}

// ── BACKFILL AUTOMÁTICO DE VENDAS ──
// A consulta de cupom só aceita 3 dias, e o limite é 7 chamadas/hora por
// filial. Então o preenchimento de um mês não cabe numa execução: este gatilho
// roda de hora em hora, avança o que couber e se remove quando termina.
var CFY_BLOCOS_POR_RODADA = 6;   // 6 blocos = 6 chamadas por filial, abaixo das 7

function backfillVendasAuto() {
  var hora = Number(Utilities.formatDate(new Date(), 'America/Belem', 'H'));
  if (CFY_HORAS_PERMITIDAS.indexOf(hora) === -1) {
    Logger.log('Fora da janela permitida (hora ' + hora + '). Tenta na próxima.');
    return { ok: false, erro: 'fora da janela' };
  }
  try {
    var cache = cfyLerCacheVendas_() || { dias: {} };
    var hoje = new Date();
    var fmtBR = function(d) { return Utilities.formatDate(d, 'America/Belem', 'dd/MM/yyyy'); };

    // Alvo: do dia 1 do mês anterior até hoje.
    var ini = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
    var faltando = [];
    for (var d = new Date(ini); d <= hoje; d = new Date(d.getTime() + 86400000)) {
      if (!cache.dias[fmtBR(d)]) faltando.push(new Date(d));
    }
    if (!faltando.length) {
      ScriptApp.getProjectTriggers().forEach(function(t) {
        if (t.getHandlerFunction() === 'backfillVendasAuto') ScriptApp.deleteTrigger(t);
      });
      Logger.log('Backfill de vendas concluído: nada faltando. Gatilho removido.');
      return { ok: true, concluido: true };
    }

    var feitos = 0;
    for (var b = 0; b < CFY_BLOCOS_POR_RODADA && faltando.length; b++) {
      var dIni = faltando[0];
      var dFim = new Date(dIni.getTime() + (CFY_DIAS_VENDAS - 1) * 86400000);
      if (dFim > hoje) dFim = hoje;
      cfyVendasPeriodo_(dIni, dFim);
      // tira do pendente os dias que acabaram de entrar
      faltando = faltando.filter(function(x) { return x < dIni || x > dFim; });
      feitos++;
    }
    Logger.log('Backfill de vendas: ' + feitos + ' bloco(s) nesta rodada, ' + faltando.length + ' dia(s) ainda faltando.');
    return { ok: true, blocos: feitos, faltando: faltando.length };
  } catch (err) {
    Logger.log('Falha no backfill de vendas: ' + err.message);
    return { ok: false, erro: err.message };
  }
}

// Liga o preenchimento automático: roda de hora em hora e se desliga sozinho
// quando o período estiver completo.
function instalarBackfillVendas() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'backfillVendasAuto') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('backfillVendasAuto').timeBased().everyHours(1).create();
  var r = backfillVendasAuto();   // já adianta a primeira rodada
  return 'Backfill ligado (de hora em hora). Primeira rodada: ' + JSON.stringify(r);
}

function instalarGatilhoVendas() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'atualizarCacheVendas') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('atualizarCacheVendas').timeBased().atHour(10).everyDays(1).create();
  return 'Gatilho diário de vendas criado (10h).';
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
