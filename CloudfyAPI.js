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
  { nr: 3, nome: 'PORTO FUTURO' },
  // A filial 4 ESTÁ comprando: consulta de 10/09 a 07/10/2026 em 07/10 trouxe
  // 7 notas, R$ 11.504,18 (açaí em lata dos fornecedores da feira, mais uma
  // transferência do Umarizal). Ficar de fora da lista deixava o CMC do
  // quiosque permanentemente zerado.
  { nr: 4, nome: 'ACAI NA CUIA' }
];

// VENDAS tem lista PRÓPRIA. A de compras exclui a filial 4 de propósito,
// porque o Açaí na Cuia não compra -- mas ele VENDE, e reaproveitar a lista de
// compras aqui fazia o faturamento dele sumir do painel inteiro. Em 03-05/10/2026
// eram 53 cupons e R$ 2.546,50 que não chegavam em lugar nenhum.
var CFY_FILIAIS_VENDA = [
  { nr: 1, nome: 'UMARIZAL' },
  { nr: 2, nome: 'MARCO' },
  { nr: 3, nome: 'PORTO FUTURO' },
  { nr: 4, nome: 'ACAI NA CUIA' }
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
  // Mesmo cuidado das vendas: sem compra no período vem {} em vez de [].
  var compras = Array.isArray(rs.Compras) ? rs.Compras : [];
  compras.forEach(function(c) {
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
    // Uma filial que falhar (limite de consultas por hora, instabilidade) não
    // pode derrubar a gravação inteira: antes, qualquer erro abortava tudo e o
    // cache ficava com os dados velhos sem nada na tela denunciando. Agora cada
    // par mês+filial é independente -- quem veio é substituído, quem falhou
    // mantém o que já estava gravado.
    var todas = [], okMesFilial = {}, naoIntegradoPorMes = {}, falhas = [];
    janelas.forEach(function(j) {
      var acum = [];
      CFY_FILIAIS_COMPRA.forEach(function(f) {
        try {
          var linhasF = cfyComprasLinhas_(f.nr, f.nome, j.ini, j.fim, mapaGrupos, acum, fornecedores);
          todas = todas.concat(linhasF);
          okMesFilial[j.ref + '|' + f.nome] = true;
        } catch (e) {
          falhas.push(j.ref + ' / ' + f.nome + ': ' + e.message);
          Logger.log('FALHA em ' + j.ref + ' / ' + f.nome + ' -- mantendo o que já estava no cache. ' + e.message);
        }
      });
      if (acum.length) naoIntegradoPorMes[j.nome] = acum;
    });
    if (!todas.length) throw new Error('Nenhuma filial respondeu. ' + falhas.join(' | '));

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
        var fil = String(r[C_COMPRAS.filial] || '').trim();
        // Só descarta a linha antiga se a filial daquele mês foi rebuscada com
        // sucesso agora. Senão ela sobrevive -- é o que impede uma falha
        // pontual de apagar dado bom.
        if (!okMesFilial[ref + '|' + fil]) preservadas.push(r);
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
    var resumo = 'Cache de compras: ' + todas.length + ' linhas novas (' +
                 Object.keys(okMesFilial).join(', ') + '), ' + preservadas.length + ' preservadas.';
    if (falhas.length) resumo += '  ATENÇÃO -- ' + falhas.length + ' falha(s), dado antigo mantido: ' + falhas.join(' | ');
    Logger.log(resumo);
    return { ok: true, linhas: todas.length, preservadas: preservadas.length, falhas: falhas };
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

// Diagnóstico: mostra o que está REALMENTE gravado no cache de compras, por
// mês e filial. Serve pra separar "o dado não veio" de "o dado veio e o
// cálculo está diferente" sem precisar abrir a planilha.
function diagnosticarComprasCache() {
  var cache = cfyLerCacheCompras_();
  if (!cache || !cache.linhas.length) return 'Cache de compras VAZIO. Rode atualizarCacheCompras().';

  var porMesFilial = {}, semData = 0;
  cache.linhas.forEach(function(r) {
    var d = cfyDataBR_(r[C_COMPRAS.data]);
    if (d.length < 10) { semData++; return; }
    var ref = d.slice(3, 5) + '/' + d.slice(6, 10);
    var fil = String(r[C_COMPRAS.filial] || '?').trim();
    var k = ref + ' | ' + fil;
    if (!porMesFilial[k]) porMesFilial[k] = { linhas: 0, total: 0, transf: 0, dias: {} };
    var o = porMesFilial[k];
    var v = numVal(r[C_COMPRAS.total]);
    o.linhas++; o.total += v;
    o.dias[d.slice(0, 2)] = true;
    if (String(r[C_COMPRAS_FORNECEDOR] || '').toUpperCase().indexOf(TRANSFERENCIA_MARCADOR) >= 0) o.transf += v;
  });

  var linhas = ['CACHE DE COMPRAS — atualizado em ' + (cfyComprasAtualizadoEm() || '?'),
                'total de linhas: ' + cache.linhas.length + (semData ? '  (' + semData + ' SEM DATA VÁLIDA)' : ''), ''];
  Object.keys(porMesFilial).sort().forEach(function(k) {
    var o = porMesFilial[k];
    linhas.push(k + ': ' + o.linhas + ' linhas, ' + Object.keys(o.dias).length + ' dias, ' +
                'total R$ ' + o.total.toFixed(2) + ', transferência R$ ' + o.transf.toFixed(2) +
                ', externa R$ ' + (o.total - o.transf).toFixed(2));
  });
  var txt = linhas.join('\n');
  Logger.log(txt);
  return txt;
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

// Nome de catálogo de cada código, lido do cache de fichas (COD -> PRODUTO).
// É o desempate pra escolher COMO chamar um código que chega com vários nomes.
function cfyNomeCatalogoPorCodigo_() {
  var mapa = {};
  try {
    var fichas = cfyLerCacheFichas_();
    if (fichas) {
      for (var i = 1; i < fichas.length; i++) {
        var cod  = String(fichas[i][0] || '').trim();
        var nome = String(fichas[i][1] || '').trim();
        if (cod && nome && !mapa[cod]) mapa[cod] = nome;
      }
    }
  } catch (e) {
    Logger.log('Sem cache de fichas pra nomear produto por código: ' + e.message);
  }
  return mapa;
}

// Escolhe a chave de maior valor acumulado. Usado pra decidir o nome e o grupo
// de um código quando a ficha não resolve.
function cfyMaiorPorValor_(obj) {
  var melhor = null, maior = -1;
  Object.keys(obj || {}).forEach(function(k) {
    if (obj[k] > maior) { maior = obj[k]; melhor = k; }
  });
  return melhor;
}

// CFYCC870 -> linhas no layout C_VENDAS.
//
// Agrega por CodRefProduto, NÃO pelo nome. A API devolve o MESMO código com
// nomes diferentes -- o do catálogo no salão e o do iFood no delivery -- e
// agregar por nome quebrava um produto em vários. Em setembro/2026 eram 68
// códigos nessa situação: 10.474 unidades e R$ 301.686,92 que não chegavam no
// produto da ficha, tirando R$ 75.225,32 do CMV Teórico. O caso extremo era o
// código 405, com 43 unidades em "MINI FILE BACURI" e 1.246 em
// "Mini File Bacurizinho".
//
// O nome vira só rótulo: vale o do catálogo (ficha) e, sem ela, o nome que
// mais faturou. O grupo segue a mesma regra, mas descarta grupo só numérico
// ("1", "23"), que é como o cadastro do iFood chega.
function cfyVendasLinhas_(codFilial, nomeFilial, dataIni, dataFim) {
  var rs = cfyChamar_('CFYCC870', {
    DataInicio: dataIni, DataFim: dataFim,
    SituacaoCupom: 1, IdentifDesconto: 1, IdentifTaxaServico: 1,
    IdentifConsultaProd: 1, IdentifConsultaFormaPagto: 1,
    IdentifConsultaProdCancelados: 2
  }, codFilial);

  var nomeCatalogo = cfyNomeCatalogoPorCodigo_();
  var soNumero = /^\d+$/;

  // agrega cupom -> dia + CÓDIGO
  var mapa = {};
  // Filial sem venda no período devolve CuponsVenda como OBJETO VAZIO, não
  // como array -- e {} é truthy, então o "|| []" não salvava e o forEach
  // estourava. Visto na filial 4 consultando setembro, antes dela abrir.
  var cupons = Array.isArray(rs.CuponsVenda) ? rs.CuponsVenda : [];
  cupons.forEach(function(c) {
    if (String(c.DescSituacao || '') !== 'Finalizado') return;
    var s = String(c.DataMovimento);
    var dataBR = s.slice(6, 8) + '/' + s.slice(4, 6) + '/' + s.slice(0, 4);
    (c.Produtos || []).forEach(function(p) {
      if (String(p.DescSituacaoItem || '') !== 'Finalizado') return;
      var nome = cfyTexto_(p.DescProduto);
      var cod  = cfyTexto_(p.CodRefProduto);
      if (!nome && !cod) return;
      // Item sem código no cupom (modificador, lançamento avulso) continua
      // agregado pelo nome: não há o que unificar.
      var chave = dataBR + '|' + (cod ? 'C' + cod : 'N' + nome);
      if (!mapa[chave]) {
        mapa[chave] = { data: dataBR, cod: cod, qtd: 0, valor: 0, nomes: {}, grupos: {} };
      }
      var m = mapa[chave];
      var val = Number(p.VlrTotalLiq || p.VlrTotal) || 0;
      m.qtd   += Number(p.Qtde) || 0;
      m.valor += val;
      // Peso mínimo pra que item que só sai a R$ 0 (componente de menu) ainda
      // consiga nomear o código quando for a única ocorrência.
      var peso = val > 0 ? val : 0.0001;
      if (nome) m.nomes[nome] = (m.nomes[nome] || 0) + peso;
      var g = cfyTexto_(cfyCampo_(p, 'DescGrupo'));
      if (g) m.grupos[g] = (m.grupos[g] || 0) + peso;
    });
  });

  return Object.keys(mapa).map(function(k) {
    var v = mapa[k];
    var nome = (v.cod && nomeCatalogo[v.cod]) ? nomeCatalogo[v.cod] : cfyMaiorPorValor_(v.nomes);
    var grupos = Object.keys(v.grupos);
    var comNome = {};
    grupos.forEach(function(g) { if (!soNumero.test(g)) comNome[g] = v.grupos[g]; });
    var grupo = cfyMaiorPorValor_(Object.keys(comNome).length ? comNome : v.grupos) || '';
    var linha = new Array(15);
    for (var i = 0; i < 15; i++) linha[i] = '';
    linha[C_VENDAS.filial]  = nomeFilial;
    linha[C_VENDAS.data]    = v.data;
    linha[C_VENDAS.produto] = nome || '';
    linha[C_VENDAS.grupo]   = grupo;
    linha[C_VENDAS.qtd]     = v.qtd;
    linha[C_VENDAS.valor]   = v.valor;
    return linha;
  }).filter(function(l) { return l[C_VENDAS.produto]; });
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

    // Uma filial que falhar não derruba as outras nem apaga o que já existe.
    var todas = [], okFilial = {}, falhas = [];
    CFY_FILIAIS_VENDA.forEach(function(f) {
      try {
        todas = todas.concat(cfyVendasLinhas_(f.nr, f.nome, fmt(ini), fmt(hoje)));
        okFilial[f.nome] = true;
      } catch (e) {
        falhas.push(f.nome + ': ' + e.message);
        Logger.log('FALHA em vendas / ' + f.nome + ' -- mantendo o cache anterior. ' + e.message);
      }
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
        var fil = String(r[C_VENDAS.filial] || '').trim();
        // Linha antiga só sai se a filial daquele dia foi rebuscada com sucesso.
        if (d && !(diasBuscados[d] && okFilial[fil])) preservadas.push(r);
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
    if (falhas.length) Logger.log('ATENÇÃO -- vendas com ' + falhas.length + ' falha(s), dado antigo mantido: ' + falhas.join(' | '));
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

  // try/catch por filial: sem ele, uma filial que estoura (cota, rede, ou a
  // filial 4 num período em que ainda não existia) abortava a janela inteira
  // e o backfill parava de avançar.
  var todas = [], falhasP = [];
  CFY_FILIAIS_VENDA.forEach(function(f) {
    try {
      todas = todas.concat(cfyVendasLinhas_(f.nr, f.nome, fmt(ini), fmt(fim)));
    } catch (e) {
      falhasP.push(f.nome + ': ' + e.message);
      Logger.log('Vendas / ' + f.nome + ' falhou nesta janela: ' + e.message);
    }
  });
  if (falhasP.length === CFY_FILIAIS_VENDA.length) {
    // Todas falharam: não regrava nada, senão apagaria o dia que já existia.
    throw new Error('Nenhuma filial respondeu: ' + falhasP.join(' | '));
  }

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
    var brutas = aba.getRange(2, 1, aba.getLastRow() - 1, 15).getValues();

    // cfyVendasLinhas_ já agrega por dia+produto dentro de cada filial, então
    // filial|data|produto é único POR GRAVAÇÃO. Linha repetida só aparece se o
    // mesmo dia foi gravado duas vezes (duas execuções do backfill pegando a
    // mesma janela). Aconteceu: 1.753 linhas repetidas, R$ 299 mil, os dias
    // 01 a 03/09/2026 em dobro -- o faturamento de setembro saía R$ 274 mil
    // maior que a soma dos cupons da própria API.
    // Dedupe na LEITURA, ficando com a última ocorrência (é a mais recente,
    // porque o backfill escreve no fim). Assim o número fica certo mesmo com o
    // cache sujo, sem precisar reescrever a planilha.
    var ultimaPorChave = {};
    for (var i = 0; i < brutas.length; i++) {
      var rb = brutas[i];
      var ch = String(rb[C_VENDAS.filial]) + '|' + cfyDataBR_(rb[C_VENDAS.data]) +
               '|' + String(rb[C_VENDAS.produto]);
      ultimaPorChave[ch] = i;
    }
    var linhas = [], dias = {}, repetidas = 0;
    for (var k = 0; k < brutas.length; k++) {
      var r = brutas[k];
      var d = cfyDataBR_(r[C_VENDAS.data]);
      var chave = String(r[C_VENDAS.filial]) + '|' + d + '|' + String(r[C_VENDAS.produto]);
      if (ultimaPorChave[chave] !== k) { repetidas++; continue; }
      r[C_VENDAS.data] = d;   // o painel espera dd/MM/yyyy como texto
      if (d) dias[d] = true;
      linhas.push(r);
    }
    if (repetidas) {
      Logger.log('Cache de vendas: ' + repetidas + ' linha(s) repetida(s) ignorada(s) na leitura. ' +
                 'Rode limparDuplicatasCacheVendas() pra tirar da planilha.');
    }
    return { linhas: linhas, dias: dias };
  } catch (err) {
    Logger.log('Cache de vendas indisponível: ' + err.message);
    return null;
  }
}

// Tira da planilha as linhas repetidas que cfyLerCacheVendas_ já ignora na
// leitura. Rodar é opcional -- o número do painel já sai certo sem isso --,
// mas deixa a aba menor e evita confundir quem abrir a planilha na mão.
// Mantém a ÚLTIMA ocorrência de cada filial|data|produto.
function limparDuplicatasCacheVendas() {
  var ss  = obterFichasManuaisSheet_();
  var aba = ss.getSheetByName(CFY_ABA_VENDAS);
  if (!aba || aba.getLastRow() < 2) return 'cache de vendas vazio';
  var brutas = aba.getRange(2, 1, aba.getLastRow() - 1, 15).getValues();
  var ultima = {};
  brutas.forEach(function(r, i) {
    ultima[String(r[C_VENDAS.filial]) + '|' + cfyDataBR_(r[C_VENDAS.data]) +
           '|' + String(r[C_VENDAS.produto])] = i;
  });
  var limpas = brutas.filter(function(r, i) {
    return ultima[String(r[C_VENDAS.filial]) + '|' + cfyDataBR_(r[C_VENDAS.data]) +
                  '|' + String(r[C_VENDAS.produto])] === i;
  });
  var removidas = brutas.length - limpas.length;
  if (!removidas) return 'nenhuma duplicata encontrada (' + brutas.length + ' linhas)';
  aba.getRange(2, 1, brutas.length, 15).clearContent();
  if (limpas.length) {
    aba.getRange(2, 1, limpas.length, 15).setValues(limpas);
    cfyFormatarColunaData_(aba, C_VENDAS.data, limpas.length);
  }
  var msg = removidas + ' linha(s) repetida(s) removida(s). Cache ficou com ' + limpas.length + '.';
  Logger.log(msg);
  return msg;
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

// ── REFAZER O HISTÓRICO DE VENDAS ─────────────────────────────
// O cache gravado antes de 07/10/2026 foi agregado por NOME do produto. Com a
// agregação por CÓDIGO (ver cfyVendasLinhas_), os dias antigos continuariam com
// o produto quebrado em vários nomes. Estas duas funções reconsultam a API e
// regravam cada dia já existente no cache, respeitando o limite de 7 consultas
// por hora e por filial.
//
// Diferente do backfillVendasAuto, que só busca dia AUSENTE, aqui o alvo é
// justamente o dia que já está lá.
var CFY_PROP_REFAZER = 'CFY_VENDAS_REFAZER_PENDENTE';

function iniciarRefazerVendas() {
  var cache = cfyLerCacheVendas_();
  if (!cache || !cache.linhas.length) return 'Cache de vendas vazio: nada a refazer.';
  var dias = Object.keys(cache.dias).sort(function(a, b) {
    return (a.slice(6) + a.slice(3, 5) + a.slice(0, 2)) < (b.slice(6) + b.slice(3, 5) + b.slice(0, 2)) ? -1 : 1;
  });
  PropertiesService.getScriptProperties().setProperty(CFY_PROP_REFAZER, JSON.stringify(dias));
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'refazerVendasAuto') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refazerVendasAuto').timeBased().everyHours(1).create();
  var r = refazerVendasAuto();   // adianta a primeira rodada
  return 'Refazer ligado: ' + dias.length + ' dia(s) na fila (' + dias[0] + ' a ' +
         dias[dias.length - 1] + '). Primeira rodada: ' + JSON.stringify(r);
}

function refazerVendasAuto() {
  var props = PropertiesService.getScriptProperties();
  var bruto = props.getProperty(CFY_PROP_REFAZER);
  var pendentes = bruto ? JSON.parse(bruto) : [];
  if (!pendentes.length) {
    ScriptApp.getProjectTriggers().forEach(function(t) {
      if (t.getHandlerFunction() === 'refazerVendasAuto') ScriptApp.deleteTrigger(t);
    });
    props.deleteProperty(CFY_PROP_REFAZER);
    Logger.log('Refazer vendas concluído: fila vazia. Gatilho removido.');
    return { ok: true, concluido: true };
  }
  var hora = Number(Utilities.formatDate(new Date(), 'America/Belem', 'H'));
  if (CFY_HORAS_PERMITIDAS.indexOf(hora) === -1) {
    Logger.log('Refazer vendas: fora da janela da API (hora ' + hora + '). ' +
               pendentes.length + ' dia(s) na fila. Tenta na próxima.');
    return { ok: false, erro: 'fora da janela', faltando: pendentes.length };
  }
  var emData = function(s) {
    var p = s.split('/');
    return new Date(Number(p[2]), Number(p[1]) - 1, Number(p[0]));
  };
  var fmtBR = function(d) { return Utilities.formatDate(d, 'America/Belem', 'dd/MM/yyyy'); };
  var feitos = 0;
  try {
    for (var b = 0; b < CFY_BLOCOS_POR_RODADA && pendentes.length; b++) {
      var dIni = emData(pendentes[0]);
      var dFim = new Date(dIni.getTime() + (CFY_DIAS_VENDAS - 1) * 86400000);
      cfyVendasPeriodo_(dIni, dFim);
      // tira da fila os dias que a janela acabou de regravar
      var cobertos = {};
      for (var d = new Date(dIni); d <= dFim; d = new Date(d.getTime() + 86400000)) cobertos[fmtBR(d)] = true;
      pendentes = pendentes.filter(function(x) { return !cobertos[x]; });
      feitos++;
      props.setProperty(CFY_PROP_REFAZER, JSON.stringify(pendentes));
    }
  } catch (err) {
    // Guarda o que sobrou: a próxima rodada continua de onde parou em vez de
    // perder a fila inteira por causa de uma falha de rede ou de cota.
    props.setProperty(CFY_PROP_REFAZER, JSON.stringify(pendentes));
    Logger.log('Refazer vendas interrompido: ' + err.message + '. ' + pendentes.length + ' dia(s) na fila.');
    return { ok: false, erro: err.message, blocos: feitos, faltando: pendentes.length };
  }
  Logger.log('Refazer vendas: ' + feitos + ' bloco(s) nesta rodada, ' + pendentes.length + ' dia(s) na fila.');
  return { ok: true, blocos: feitos, faltando: pendentes.length };
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
