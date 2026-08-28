// ============================================================
//  CARVO Consultoria | Amazônia na Cuia — Painel Analítico
//  Dados.gs — Processamento dos CSVs do Cloudfy
//  Versão: 1.1
// ============================================================

// ── ÍNDICES DE COLUNA (Cloudfy TSV) ─────────────────────────
// O Cloudfy exporta com os cabeçalhos deslocados.
// Os índices abaixo representam a posição real dos dados.
//
// COMPRAS (Relatório de Compras por Data e Produto):
var C_COMPRAS = {
  filial:       0,   // ex: UMARIZAL
  data:         1,   // ex: 01/05/2026
  produto:      4,   // ex: MP CHEIRO VERDE KG
  grupo:        5,   // ex: MP HORTIFRUTI
  qtd:          7,   // ex: 4,6
  unid:         8,   // ex: KG
  custo_atual:  11,  // ex: 158,7  (custo unitário atual)
  total:        17   // ex: 730    (qtd * custo_atual)
};

// VENDAS (Relatório de Vendas por Produto):
var C_VENDAS = {
  filial:  0,   // ex: MARCO
  data:    1,   // ex: 01/05/2026
  produto: 3,   // ex: CG TACACA
  grupo:   4,   // ex: CUIA GRANDE
  qtd:     13,  // quantidade total vendida
  valor:   14   // valor total em R$
};

// Grupos excluídos da Curva ABC (taxas não compõem faturamento)
var GRUPOS_EXCLUIR_ABC = ['TAXAS OPERACIONAIS'];

// Transferências entre unidades: no relatório de compras, aparecem como
// "fornecedor" que é a própria empresa. Identificadas pelo nome do fornecedor.
// O índice da coluna fornecedor no CSV de compras é 2.
var C_COMPRAS_FORNECEDOR = 2;
var TRANSFERENCIA_MARCADOR = 'AMAZONIA NA CUIA';

// Mapa do nome da origem da transferência para a filial real do sistema.
// O relatório registra a origem pelo nome do fornecedor (ex: "AMAZONIA NA CUIA DUQUE"),
// que nem sempre bate com o nome da filial. Ajuste conforme o cliente.
// A chave é o trecho do nome do fornecedor APÓS "AMAZONIA NA CUIA".
var MAPA_ORIGEM_FILIAL = {
  'DUQUE': 'MARCO',
  'PORTO FUTURO': 'PORTO FUTURO',
  'UMARIZAL': 'UMARIZAL',
  'MARCO': 'MARCO'
};

// Resolve o nome da filial de origem a partir do nome do fornecedor de transferência
function filialOrigem(fornecedor) {
  var resto = String(fornecedor || '').toUpperCase().replace(TRANSFERENCIA_MARCADOR, '').trim();
  return MAPA_ORIGEM_FILIAL[resto] || resto || 'OUTRA';
}

// ── UTILITÁRIOS ──────────────────────────────────────────────

// Parseia número de string com vírgula ou ponto como decimal
function numVal(str) {
  if (str === null || str === undefined) return 0;
  var s = String(str).trim().replace(/"/g, '').replace(/\./g, '').replace(',', '.');
  var v = parseFloat(s);
  return isNaN(v) ? 0 : v;
}

// Parseia data DD/MM/YYYY e retorna número do mês (1-12) ou null
function mesNum(str) {
  if (!str) return null;
  var s = String(str).trim().replace(/"/g, '');
  var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return parseInt(m[2], 10);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return parseInt(m[2], 10);
  return null;
}

var NOMES_MESES = {
  1:'JANEIRO',  2:'FEVEREIRO', 3:'MARÇO',    4:'ABRIL',
  5:'MAIO',     6:'JUNHO',     7:'JULHO',    8:'AGOSTO',
  9:'SETEMBRO', 10:'OUTUBRO',  11:'NOVEMBRO', 12:'DEZEMBRO'
};

function r2(v) { return Math.round(v * 100) / 100; }
function r4(v) { return Math.round(v * 10000) / 10000; }

function limpaCelula(val) {
  return String(val || '').trim().replace(/"/g, '');
}

// ── PROCESSAR COMPRAS → CMC ──────────────────────────────────

function processarCompras(rows) {
  if (!rows || rows.length < 2) {
    throw new Error('CSV de compras vazio ou sem linhas de dados.');
  }

  // Agregar por mês + filial + produto + grupo
  // Custo médio ponderado = sum(Total) / sum(Qtd)
  // Transferências entre unidades são separadas do CMC (não são compra externa).
  var agg = {};
  var transf = {};  // mes → { total, filiais:{ FIL:{total, origens:{}, produtos:[] } } }

  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r || r.length < 18) continue;

    var custoUnit = numVal(r[C_COMPRAS.custo_atual]);
    var total     = numVal(r[C_COMPRAS.total]);
    var qtd       = numVal(r[C_COMPRAS.qtd]);
    if (custoUnit <= 0 || total <= 0 || qtd <= 0) continue;

    var mes = mesNum(r[C_COMPRAS.data]);
    if (!mes) continue;
    var mesNome = NOMES_MESES[mes];

    var prod   = limpaCelula(r[C_COMPRAS.produto]);
    var grupo  = limpaCelula(r[C_COMPRAS.grupo]);
    var unid   = limpaCelula(r[C_COMPRAS.unid]);
    var filial = limpaCelula(r[C_COMPRAS.filial]) || 'OUTRA';
    if (!prod || !grupo) continue;

    // Detectar transferência interna pelo nome do fornecedor
    var fornecedor = limpaCelula(r[C_COMPRAS_FORNECEDOR]);
    var pareceTransf = fornecedor.toUpperCase().indexOf(TRANSFERENCIA_MARCADOR) >= 0;
    var filDestino = filial;
    var filOrig = pareceTransf ? filialOrigem(fornecedor) : null;
    // So tratamos como transferencia se a origem resolvida for uma filial
    // DIFERENTE do destino. Se resolver pra mesma filial (fornecedor nao
    // mapeado em MAPA_ORIGEM_FILIAL, ou mapeado por engano pra si mesma),
    // registrar como transferencia geraria uma "entrada" sem "saida"
    // correspondente, inflando o CMC/CMV da unidade sem motivo real.
    var ehTransf = pareceTransf && filOrig !== filDestino;

    if (pareceTransf && !ehTransf) {
      Logger.log('AVISO: transferencia com origem igual ao destino (' + filDestino +
                  '), fornecedor="' + fornecedor + '". Tratando como compra externa.');
    }

    if (ehTransf) {
      // Acumular como transferência, fora do CMC de compra externa.
      // A filial de destino RECEBEU (entrada). A filial de origem ENVIOU (saída).
      if (!transf[mesNome]) transf[mesNome] = { total:0, filiais:{} };
      transf[mesNome].total += total;

      // Registro de ENTRADA na filial de destino
      if (!transf[mesNome].filiais[filDestino]) {
        transf[mesNome].filiais[filDestino] = { total:0, entrada:0, saida:0, entradaQtd:0, saidaQtd:0, origens:{}, produtos:[] };
      }
      var tfD = transf[mesNome].filiais[filDestino];
      tfD.total      += total;
      tfD.entrada    += total;
      tfD.entradaQtd += qtd;
      tfD.origens[fornecedor] = (tfD.origens[fornecedor] || 0) + total;
      tfD.produtos.push({ nome:prod, grupo:grupo, origem:fornecedor, destino:filDestino, qtd:r2(qtd), valor:r2(total), data:limpaCelula(r[C_COMPRAS.data]) });

      // Registro de SAÍDA na filial de origem
      if (!transf[mesNome].filiais[filOrig]) {
        transf[mesNome].filiais[filOrig] = { total:0, entrada:0, saida:0, entradaQtd:0, saidaQtd:0, origens:{}, produtos:[] };
      }
      transf[mesNome].filiais[filOrig].saida    += total;
      transf[mesNome].filiais[filOrig].saidaQtd += qtd;
      continue;  // não entra no CMC de compra externa
    }

    // Compra externa: entra no CMC normalmente
    var chave = mesNome + '||' + filial + '||' + prod + '||' + grupo;
    if (!agg[chave]) {
      agg[chave] = { mes:mesNome, filial:filial, prod:prod, grupo:grupo, unid:unid, qtd:0, total:0 };
    }
    agg[chave].qtd   += qtd;
    agg[chave].total += total;
  }

  // Montar CMC: mês → filial → grupo → produto[]
  // Estrutura: cmc[mes] = { cmc_total, faturamento, filiais: { FILIAL: {cmc_total, grupos:{...}} }, grupos:{...consolidado...} }
  var cmc = {};

  Object.keys(agg).forEach(function(chave) {
    var a = agg[chave];
    a.custo_unit = r4(a.total / a.qtd);

    if (!cmc[a.mes]) {
      cmc[a.mes] = { cmc_total:0, faturamento:0, cmc_pct_fat:null, grupos:{}, filiais:{} };
    }
    var mesObj = cmc[a.mes];

    // ── Consolidado (todas as filiais) ──
    if (!mesObj.grupos[a.grupo]) mesObj.grupos[a.grupo] = { total:0, pct_cmc:null, produtos:[], _pidx:{} };
    var gCons = mesObj.grupos[a.grupo];
    // Consolidar produto entre filiais
    if (gCons._pidx[a.prod] === undefined) {
      gCons._pidx[a.prod] = gCons.produtos.length;
      gCons.produtos.push({ nome:a.prod, unid:a.unid, qtd:0, valor:0, custo_unit:0 });
    }
    var pCons = gCons.produtos[gCons._pidx[a.prod]];
    pCons.qtd   += a.qtd;
    pCons.valor += a.total;
    gCons.total += a.total;
    mesObj.cmc_total += a.total;

    // ── Por filial ──
    if (!mesObj.filiais[a.filial]) mesObj.filiais[a.filial] = { cmc_total:0, grupos:{} };
    var filObj = mesObj.filiais[a.filial];
    if (!filObj.grupos[a.grupo]) filObj.grupos[a.grupo] = { total:0, pct_cmc:null, produtos:[] };
    var gFil = filObj.grupos[a.grupo];
    gFil.produtos.push({ nome:a.prod, unid:a.unid, qtd:r2(a.qtd), valor:r2(a.total), custo_unit:a.custo_unit });
    gFil.total       += a.total;
    filObj.cmc_total += a.total;
  });

  // Finalizar: custo ponderado consolidado, percentuais, ordenação
  Object.keys(cmc).forEach(function(mes) {
    var mesObj = cmc[mes];
    mesObj.cmc_total = r2(mesObj.cmc_total);

    // Consolidado
    Object.keys(mesObj.grupos).forEach(function(gr) {
      var g = mesObj.grupos[gr];
      g.produtos.forEach(function(p) {
        p.custo_unit = p.qtd > 0 ? r4(p.valor / p.qtd) : 0;
        p.qtd   = r2(p.qtd);
        p.valor = r2(p.valor);
      });
      g.total   = r2(g.total);
      g.pct_cmc = r2(g.total / mesObj.cmc_total * 100);
      g.produtos.sort(function(a, b) { return b.valor - a.valor; });
      delete g._pidx;
    });

    // Por filial
    Object.keys(mesObj.filiais).forEach(function(fil) {
      var filObj = mesObj.filiais[fil];
      filObj.cmc_total = r2(filObj.cmc_total);
      Object.keys(filObj.grupos).forEach(function(gr) {
        var g = filObj.grupos[gr];
        g.total   = r2(g.total);
        g.pct_cmc = r2(g.total / filObj.cmc_total * 100);
        g.produtos.sort(function(a, b) { return b.valor - a.valor; });
      });
    });
  });

  // Anexar transferências entre unidades a cada mês
  Object.keys(transf).forEach(function(mes){
    if (!cmc[mes]) return;
    var tm = transf[mes];
    cmc[mes].transferencias = {
      total: r2(tm.total),
      filiais: {}
    };
    Object.keys(tm.filiais).forEach(function(fil){
      var tf = tm.filiais[fil];
      // ordenar produtos por valor
      tf.produtos.sort(function(a,b){ return b.valor - a.valor; });
      var origens = Object.keys(tf.origens).map(function(o){
        return { origem:o, valor:r2(tf.origens[o]) };
      }).sort(function(a,b){ return b.valor - a.valor; });
      // Saldo liquido de transferencia da unidade = entrada (recebeu) - saida (enviou)
      var entrada    = tf.entrada    || 0;
      var saida      = tf.saida      || 0;
      var entradaQtd = tf.entradaQtd || 0;
      var saidaQtd   = tf.saidaQtd   || 0;

      // Consolidar por produto: cada produto vira uma linha com o total,
      // e guarda os lancamentos individuais (data, qtd, valor, origem) dentro.
      var porProduto = {};
      var ordemProduto = [];
      tf.produtos.forEach(function(p){
        if (!porProduto[p.nome]) {
          porProduto[p.nome] = { nome:p.nome, grupo:p.grupo, qtd:0, valor:0, lancamentos:[] };
          ordemProduto.push(p.nome);
        }
        var pc = porProduto[p.nome];
        pc.qtd   += p.qtd;
        pc.valor += p.valor;
        pc.lancamentos.push({ data:p.data, origem:p.origem, qtd:p.qtd, valor:p.valor });
      });
      var produtosConsolidados = ordemProduto.map(function(nome){
        var pc = porProduto[nome];
        pc.qtd = r2(pc.qtd);
        pc.valor = r2(pc.valor);
        // ordenar lancamentos por data
        pc.lancamentos.sort(function(a,b){ return (a.data||'').localeCompare(b.data||''); });
        return pc;
      }).sort(function(a,b){ return b.valor - a.valor; });

      cmc[mes].transferencias.filiais[fil] = {
        total:       r2(tf.total),
        entrada:     r2(entrada),
        saida:       r2(saida),
        entrada_qtd: r2(entradaQtd),
        saida_qtd:   r2(saidaQtd),
        saldo:       r2(entrada - saida),
        origens: origens,
        produtos: produtosConsolidados
      };
      // anexar dentro da filial do CMC: entrada, saida e saldo de transferencia
      if (cmc[mes].filiais && cmc[mes].filiais[fil]) {
        cmc[mes].filiais[fil].transf_entrada     = r2(entrada);
        cmc[mes].filiais[fil].transf_saida       = r2(saida);
        cmc[mes].filiais[fil].transf_saldo       = r2(entrada - saida);
        cmc[mes].filiais[fil].transf_entrada_qtd = r2(entradaQtd);
        cmc[mes].filiais[fil].transf_saida_qtd   = r2(saidaQtd);
      }
    });
  });

  Logger.log('CMC processado. Meses: ' + Object.keys(cmc).join(', '));
  return cmc;
}

// ── PROCESSAR VENDAS → ABC + FATURAMENTO ─────────────────────

function processarVendas(rows) {
  if (!rows || rows.length < 2) {
    throw new Error('CSV de vendas vazio ou sem linhas de dados.');
  }

  // Agregações
  var porProd      = {};   // consolidado: produto → {grupo, valor, qtd}
  var porFilial    = {};   // filial → {valor, qtd}
  var porMes       = {};   // mês → {valor, qtd}
  var porMesFilial = {};   // mês → filial → valor
  var prodFilial   = {};   // filial → produto → {grupo, valor, qtd}
  var prodMes      = {};   // mês → produto → {grupo, valor, qtd}
  var prodMesFilial= {};   // mês → filial → produto → {grupo, valor, qtd}
  var totalGeral = 0;

  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r || r.length < 15) continue;

    var grupo = limpaCelula(r[C_VENDAS.grupo]);
    var valor = numVal(r[C_VENDAS.valor]);
    if (valor <= 0) continue;
    // Comparacao sem diferenciar maiusculas/minusculas: um "Taxas Operacionais"
    // exportado com capitalizacao diferente nao deve escapar da exclusao.
    if (GRUPOS_EXCLUIR_ABC.indexOf(grupo.toUpperCase()) >= 0) continue;

    var prod   = limpaCelula(r[C_VENDAS.produto]);
    var filial = limpaCelula(r[C_VENDAS.filial]) || 'OUTRA';
    var qtd    = numVal(r[C_VENDAS.qtd]);
    if (!prod) continue;

    var mes = mesNum(r[C_VENDAS.data]);
    var mn  = mes ? NOMES_MESES[mes] : null;
    if (!mn) {
      // Sem mes reconhecido, a linha ainda entra nos totais gerais/por filial
      // (abaixo) mas nao em nenhum total mensal — Periodo completo pode ficar
      // maior que a soma dos meses se isso ocorrer. Avisa pra facilitar o diagnostico.
      Logger.log('AVISO: venda com data nao reconhecida ("' + limpaCelula(r[C_VENDAS.data]) +
                  '"), produto="' + prod + '".');
    }

    // Consolidado por produto
    if (!porProd[prod]) porProd[prod] = { grupo:grupo, valor:0, qtd:0 };
    porProd[prod].valor += valor;
    porProd[prod].qtd   += qtd;

    // Por filial (totais)
    if (!porFilial[filial]) porFilial[filial] = { valor:0, qtd:0 };
    porFilial[filial].valor += valor;
    porFilial[filial].qtd   += qtd;

    // Produto por filial
    if (!prodFilial[filial]) prodFilial[filial] = {};
    if (!prodFilial[filial][prod]) prodFilial[filial][prod] = { grupo:grupo, valor:0, qtd:0 };
    prodFilial[filial][prod].valor += valor;
    prodFilial[filial][prod].qtd   += qtd;

    if (mn) {
      // Por mês (totais)
      if (!porMes[mn]) porMes[mn] = { valor:0, qtd:0 };
      porMes[mn].valor += valor;
      porMes[mn].qtd   += qtd;

      // Por mês + filial (totais)
      if (!porMesFilial[mn]) porMesFilial[mn] = {};
      if (!porMesFilial[mn][filial]) porMesFilial[mn][filial] = 0;
      porMesFilial[mn][filial] += valor;

      // Produto por mês (consolidado entre filiais)
      if (!prodMes[mn]) prodMes[mn] = {};
      if (!prodMes[mn][prod]) prodMes[mn][prod] = { grupo:grupo, valor:0, qtd:0 };
      prodMes[mn][prod].valor += valor;
      prodMes[mn][prod].qtd   += qtd;

      // Produto por mês + filial
      if (!prodMesFilial[mn]) prodMesFilial[mn] = {};
      if (!prodMesFilial[mn][filial]) prodMesFilial[mn][filial] = {};
      if (!prodMesFilial[mn][filial][prod]) prodMesFilial[mn][filial][prod] = { grupo:grupo, valor:0, qtd:0 };
      prodMesFilial[mn][filial][prod].valor += valor;
      prodMesFilial[mn][filial][prod].qtd   += qtd;
    }

    totalGeral += valor;
  }

  // Monta curva ABC de um conjunto produto → {grupo,valor,qtd}
  function montarABC(mapaProd) {
    var total = Object.keys(mapaProd).reduce(function(s, k) { return s + mapaProd[k].valor; }, 0);
    if (total <= 0) return { total:0, produtos:[] };
    var arr = Object.keys(mapaProd).map(function(prod) {
      return {
        produto: prod, grupo: mapaProd[prod].grupo,
        valor: r2(mapaProd[prod].valor), qtd: r2(mapaProd[prod].qtd),
        pct: r4(mapaProd[prod].valor / total * 100)
      };
    });
    arr.sort(function(a, b) { return b.valor - a.valor; });
    var acum = 0;
    arr.forEach(function(item) {
      acum += item.pct;
      item.pct_acum = r4(acum);
      item.classe = item.pct_acum <= 80 ? 'A' : item.pct_acum <= 95 ? 'B' : 'C';
    });
    return { total:r2(total), produtos:arr };
  }

  // ABC consolidado (período completo)
  var abcCons = montarABC(porProd);

  // ABC por filial (período completo)
  var abcFilial = {};
  Object.keys(prodFilial).forEach(function(fil) { abcFilial[fil] = montarABC(prodFilial[fil]); });

  // ABC por mês (consolidado)
  var abcMes = {};
  Object.keys(prodMes).forEach(function(mn) { abcMes[mn] = montarABC(prodMes[mn]); });

  // ABC por mês + filial
  var abcMesFilial = {};
  Object.keys(prodMesFilial).forEach(function(mn) {
    abcMesFilial[mn] = {};
    Object.keys(prodMesFilial[mn]).forEach(function(fil) {
      abcMesFilial[mn][fil] = montarABC(prodMesFilial[mn][fil]);
    });
  });

  // Totais por filial
  var byFilial = Object.keys(porFilial).map(function(f) {
    return { filial:f, valor:r2(porFilial[f].valor), qtd:r2(porFilial[f].qtd) };
  }).sort(function(a, b) { return b.valor - a.valor; });

  // Por mês (consolidado)
  var byMes = Object.keys(porMes).map(function(m) {
    return { mes:m, valor:r2(porMes[m].valor), qtd:r2(porMes[m].qtd) };
  });

  // Faturamento por mês + filial
  var byMesFilial = {};
  Object.keys(porMesFilial).forEach(function(mn) {
    byMesFilial[mn] = {};
    Object.keys(porMesFilial[mn]).forEach(function(fil) {
      byMesFilial[mn][fil] = r2(porMesFilial[mn][fil]);
    });
  });

  Logger.log('Vendas processadas. Total: R$' + r2(totalGeral) + ' | ' + abcCons.produtos.length + ' produtos');
  return {
    total_geral:    r2(totalGeral),
    qtd_total:      Object.values(porProd).reduce(function(s, p) { return s + p.qtd; }, 0),
    n_produtos:     abcCons.produtos.length,
    abc_geral:      abcCons.produtos,
    abc_filial:     abcFilial,         // { FILIAL: {total, produtos} }
    abc_mes:        abcMes,            // { MES: {total, produtos} }
    abc_mes_filial: abcMesFilial,      // { MES: { FILIAL: {total, produtos} } }
    by_filial:      byFilial,
    by_mes:         byMes,
    by_mes_filial:  byMesFilial
  };
}

// ── PROCESSAR ESTOQUE → CMV ──────────────────────────────────
//
// LÓGICA DE CONTAGEM:
//   - Cada arquivo de estoque representa UMA contagem em uma data específica
//   - Nomeie os arquivos por data: contagem_31012026.csv, contagem_28022026.csv...
//   - A contagem do dia 31/jan é EF de janeiro E EI de fevereiro automaticamente
//   - O sistema ordena todas as contagens por data e calcula EI e EF de cada mês
//
// ÍNDICES DO CSV DE ESTOQUE (ajuste conforme o export do Cloudfy):
var C_ESTOQUE = {
  filial:     0,   // Filial (ex: MARCO)
  grupo:      1,   // Grupo (ex: AGUAS E CIA)
  produto:    2,   // Nome do produto
  unid:       4,   // Unidade
  data:       5,   // Data da contagem (DD/MM/YYYY)
  centro:     6,   // Centro de estoque (CENTRAL, BAR, COZINHA...)
  tp_movto:   8,   // Tipo de movimento (Inventário, Saldo anterior...)
  saldo:      12,  // Saldo (quantidade contada)
  custo_unit: 14,  // Custo unitário
  custo_total:15   // Custo total (saldo * custo_unit)
};

// Apenas linhas com este tipo de movimento são contagem física real
var ESTOQUE_TIPO_VALIDO = 'Inventário';

// Parseia data completa DD/MM/YYYY e retorna objeto {ano, mes, dia, ts}
function parseDataCompleta(str) {
  if (!str) return null;
  var s = String(str).trim().replace(/"/g, '');
  var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) {
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return { ano: parseInt(m[1]), mes: parseInt(m[2]), dia: parseInt(m[3]),
             ts: m[1] + m[2] + m[3] };
  }
  var dia = m[1].padStart(2,'0'), mes = m[2].padStart(2,'0'), ano = m[3];
  return { ano: parseInt(ano), mes: parseInt(mes), dia: parseInt(dia),
           ts: ano + mes + dia };  // string YYYYMMDD para ordenação
}

function processarCMV(rowsEstoque, rowsCompras) {
  if (!rowsEstoque || rowsEstoque.length < 2) {
    Logger.log('CSV de estoque nao disponivel. CMV nao calculado.');
    return {};
  }

  // ── 1. Ler contagens (apenas linhas de Inventario) ──
  // Para cada data de contagem, somar o valor do estoque por grupo e total.
  // Um produto pode ter varias linhas (centros de estoque diferentes): todas somam.
  // contagensPorData: { "20251231": { total, porGrupo:{}, porFilial:{}, porFilialGrupo:{} } }
  var contagensPorData = {};

  for (var i = 1; i < rowsEstoque.length; i++) {
    var r = rowsEstoque[i];
    if (!r || r.length < 16) continue;

    var tp = limpaCelula(r[C_ESTOQUE.tp_movto]);
    if (tp !== ESTOQUE_TIPO_VALIDO) continue;  // só inventário físico

    var dataInfo = parseDataCompleta(r[C_ESTOQUE.data]);
    if (!dataInfo) continue;

    var valor = numVal(r[C_ESTOQUE.custo_total]);
    if (valor <= 0) continue;

    var grupo   = limpaCelula(r[C_ESTOQUE.grupo]);
    var filial  = limpaCelula(r[C_ESTOQUE.filial]) || 'OUTRA';
    var produto = limpaCelula(r[C_ESTOQUE.produto]);
    var ts = dataInfo.ts;

    if (!contagensPorData[ts]) {
      contagensPorData[ts] = {
        ts: ts, mes: dataInfo.mes, ano: dataInfo.ano, dia: dataInfo.dia,
        total: 0, porGrupo: {}, porFilial: {}, porFilialGrupo: {}, porProdGrupo: {}, porProdGrupoFilial: {}
      };
    }
    var c = contagensPorData[ts];
    c.total += valor;
    if (grupo)  c.porGrupo[grupo]   = (c.porGrupo[grupo]   || 0) + valor;
    if (filial) c.porFilial[filial] = (c.porFilial[filial] || 0) + valor;
    if (filial && grupo) {
      if (!c.porFilialGrupo[filial]) c.porFilialGrupo[filial] = {};
      c.porFilialGrupo[filial][grupo] = (c.porFilialGrupo[filial][grupo] || 0) + valor;
    }
    // Produto dentro do grupo (consolidado, para detalhe do CMV por produto)
    if (grupo && produto) {
      if (!c.porProdGrupo[grupo]) c.porProdGrupo[grupo] = {};
      c.porProdGrupo[grupo][produto] = (c.porProdGrupo[grupo][produto] || 0) + valor;
    }
    // Produto dentro do grupo, por filial (para detalhe do CMV por produto de uma unidade)
    if (filial && grupo && produto) {
      if (!c.porProdGrupoFilial[filial]) c.porProdGrupoFilial[filial] = {};
      if (!c.porProdGrupoFilial[filial][grupo]) c.porProdGrupoFilial[filial][grupo] = {};
      c.porProdGrupoFilial[filial][grupo][produto] = (c.porProdGrupoFilial[filial][grupo][produto] || 0) + valor;
    }
  }

  var datasOrdenadas = Object.keys(contagensPorData).sort();
  Logger.log('Contagens de estoque: ' + datasOrdenadas.join(', '));
  if (datasOrdenadas.length < 2) {
    Logger.log('Menos de 2 contagens. CMV nao pode ser calculado (precisa de EI e EF).');
    return {};
  }

  // ── 2. Compras por mes + grupo + filial ──
  var comprasMes = {};        // mes → { total, grupos:{}, filiais:{ FIL:{total,grupos:{}} } }
  if (rowsCompras && rowsCompras.length > 1) {
    for (var j = 1; j < rowsCompras.length; j++) {
      var rc = rowsCompras[j];
      if (!rc || rc.length < 18) continue;
      if (numVal(rc[C_COMPRAS.custo_atual]) <= 0) continue;
      var mC = mesNum(rc[C_COMPRAS.data]);
      if (!mC) continue;
      var mnC  = NOMES_MESES[mC];
      var grC  = limpaCelula(rc[C_COMPRAS.grupo]);
      var filC = limpaCelula(rc[C_COMPRAS.filial]) || 'OUTRA';
      var prodC= limpaCelula(rc[C_COMPRAS.produto]);
      var totC = numVal(rc[C_COMPRAS.total]);
      if (totC <= 0) continue;

      if (!comprasMes[mnC]) comprasMes[mnC] = { total:0, grupos:{}, filiais:{}, prodGrupo:{}, saidaFilial:{}, entradaFilial:{} };

      // Transferência: registrar entrada (destino) e saída (origem) separadamente,
      // com quebra por grupo (para o CMV por grupo dentro de uma unidade).
      var fornC = limpaCelula(rc[C_COMPRAS_FORNECEDOR]);
      var pareceTransfCMV = fornC.toUpperCase().indexOf(TRANSFERENCIA_MARCADOR) >= 0;
      var filOrigemCMV = pareceTransfCMV ? filialOrigem(fornC) : null;
      // Mesmo ajuste do processarCompras: so tratar como transferencia real
      // se a origem resolvida for diferente do destino. Caso contrario, cai
      // para compra externa normal (evita entrada sem saida correspondente).
      var ehTransfCMV = pareceTransfCMV && filOrigemCMV !== filC;
      if (pareceTransfCMV && !ehTransfCMV) {
        Logger.log('AVISO (CMV): transferencia com origem igual ao destino (' + filC +
                    '), fornecedor="' + fornC + '". Tratando como compra externa.');
      }
      if (ehTransfCMV) {
        var qtdTC = numVal(rc[C_COMPRAS.qtd]);

        // Entrada na filial de destino (recebeu)
        if (!comprasMes[mnC].entradaFilial) comprasMes[mnC].entradaFilial = {};
        comprasMes[mnC].entradaFilial[filC] = (comprasMes[mnC].entradaFilial[filC] || 0) + totC;
        if (!comprasMes[mnC].entradaFilialGrupo) comprasMes[mnC].entradaFilialGrupo = {};
        if (!comprasMes[mnC].entradaFilialGrupo[filC]) comprasMes[mnC].entradaFilialGrupo[filC] = {};
        if (!comprasMes[mnC].entradaFilialGrupo[filC][grC]) comprasMes[mnC].entradaFilialGrupo[filC][grC] = { valor:0, qtd:0 };
        comprasMes[mnC].entradaFilialGrupo[filC][grC].valor += totC;
        comprasMes[mnC].entradaFilialGrupo[filC][grC].qtd   += qtdTC;
        // Entrada por produto (para o detalhe de produto dentro do grupo)
        if (!comprasMes[mnC].entradaProdGrupoFilial) comprasMes[mnC].entradaProdGrupoFilial = {};
        if (!comprasMes[mnC].entradaProdGrupoFilial[filC]) comprasMes[mnC].entradaProdGrupoFilial[filC] = {};
        if (!comprasMes[mnC].entradaProdGrupoFilial[filC][grC]) comprasMes[mnC].entradaProdGrupoFilial[filC][grC] = {};
        if (!comprasMes[mnC].entradaProdGrupoFilial[filC][grC][prodC]) comprasMes[mnC].entradaProdGrupoFilial[filC][grC][prodC] = { valor:0, qtd:0 };
        comprasMes[mnC].entradaProdGrupoFilial[filC][grC][prodC].valor += totC;
        comprasMes[mnC].entradaProdGrupoFilial[filC][grC][prodC].qtd   += qtdTC;

        // Saída na filial de origem (enviou)
        comprasMes[mnC].saidaFilial[filOrigemCMV] = (comprasMes[mnC].saidaFilial[filOrigemCMV] || 0) + totC;
        if (!comprasMes[mnC].saidaFilialGrupo) comprasMes[mnC].saidaFilialGrupo = {};
        if (!comprasMes[mnC].saidaFilialGrupo[filOrigemCMV]) comprasMes[mnC].saidaFilialGrupo[filOrigemCMV] = {};
        if (!comprasMes[mnC].saidaFilialGrupo[filOrigemCMV][grC]) comprasMes[mnC].saidaFilialGrupo[filOrigemCMV][grC] = { valor:0, qtd:0 };
        comprasMes[mnC].saidaFilialGrupo[filOrigemCMV][grC].valor += totC;
        comprasMes[mnC].saidaFilialGrupo[filOrigemCMV][grC].qtd   += qtdTC;
        // Saída por produto (para o detalhe de produto dentro do grupo)
        if (!comprasMes[mnC].saidaProdGrupoFilial) comprasMes[mnC].saidaProdGrupoFilial = {};
        if (!comprasMes[mnC].saidaProdGrupoFilial[filOrigemCMV]) comprasMes[mnC].saidaProdGrupoFilial[filOrigemCMV] = {};
        if (!comprasMes[mnC].saidaProdGrupoFilial[filOrigemCMV][grC]) comprasMes[mnC].saidaProdGrupoFilial[filOrigemCMV][grC] = {};
        if (!comprasMes[mnC].saidaProdGrupoFilial[filOrigemCMV][grC][prodC]) comprasMes[mnC].saidaProdGrupoFilial[filOrigemCMV][grC][prodC] = { valor:0, qtd:0 };
        comprasMes[mnC].saidaProdGrupoFilial[filOrigemCMV][grC][prodC].valor += totC;
        comprasMes[mnC].saidaProdGrupoFilial[filOrigemCMV][grC][prodC].qtd   += qtdTC;
      }

      var qtdC = numVal(rc[C_COMPRAS.qtd]);

      // Totais CONSOLIDADOS (empresa toda): excluem transferência por completo.
      // Uma transferência não é uma segunda compra: a mercadoria já foi contada
      // quando a unidade de origem comprou de verdade do fornecedor. Contar a
      // entrada de novo no consolidado duplicaria o valor da mercadoria.
      if (!ehTransfCMV) {
        comprasMes[mnC].total += totC;
        comprasMes[mnC].grupos[grC] = (comprasMes[mnC].grupos[grC] || 0) + totC;
        if (grC && prodC) {
          if (!comprasMes[mnC].prodGrupo[grC]) comprasMes[mnC].prodGrupo[grC] = {};
          if (!comprasMes[mnC].prodGrupo[grC][prodC]) comprasMes[mnC].prodGrupo[grC][prodC] = { valor:0, qtd:0 };
          comprasMes[mnC].prodGrupo[grC][prodC].valor += totC;
          comprasMes[mnC].prodGrupo[grC][prodC].qtd   += qtdC;
        }
      }
      if (!comprasMes[mnC].filiais[filC]) comprasMes[mnC].filiais[filC] = { total:0, grupos:{}, prodGrupo:{} };
      comprasMes[mnC].filiais[filC].total += totC;
      comprasMes[mnC].filiais[filC].grupos[grC] = (comprasMes[mnC].filiais[filC].grupos[grC] || 0) + totC;

      // Compras por produto dentro do grupo, DESTA filial (valor e quantidade)
      if (grC && prodC) {
        if (!comprasMes[mnC].filiais[filC].prodGrupo[grC]) comprasMes[mnC].filiais[filC].prodGrupo[grC] = {};
        if (!comprasMes[mnC].filiais[filC].prodGrupo[grC][prodC]) comprasMes[mnC].filiais[filC].prodGrupo[grC][prodC] = { valor:0, qtd:0 };
        comprasMes[mnC].filiais[filC].prodGrupo[grC][prodC].valor += totC;
        comprasMes[mnC].filiais[filC].prodGrupo[grC][prodC].qtd   += qtdC;
      }
    }
  }

  // ── 3. CMV por mes ──
  // Cada par de contagens consecutivas define um periodo.
  // EI = contagem mais antiga, EF = contagem mais recente.
  // Mes do CMV = mes em que cai a contagem EF.
  // CMV = EI + Compras - EF
  var cmv = {};

  for (var k = 0; k < datasOrdenadas.length - 1; k++) {
    var tsEI = datasOrdenadas[k];
    var tsEF = datasOrdenadas[k + 1];
    var ei   = contagensPorData[tsEI];
    var ef   = contagensPorData[tsEF];

    var mesNome  = NOMES_MESES[ef.mes];
    var chaveMes = ef.ano + '-' + String(ef.mes).padStart(2,'0');
    var cMes     = comprasMes[mesNome];
    var compras  = cMes ? cMes.total : 0;
    var cmvReal  = ei.total + compras - ef.total;

    // CMV por grupo: EI_grupo + Compras_grupo - EF_grupo
    var gruposSet = {};
    Object.keys(ei.porGrupo).forEach(function(g){ gruposSet[g]=1; });
    Object.keys(ef.porGrupo).forEach(function(g){ gruposSet[g]=1; });
    if (cMes) Object.keys(cMes.grupos).forEach(function(g){ gruposSet[g]=1; });

    var grupos = Object.keys(gruposSet).map(function(g){
      var eiG = ei.porGrupo[g] || 0;
      var efG = ef.porGrupo[g] || 0;
      var coG = (cMes && cMes.grupos[g]) ? cMes.grupos[g] : 0;

      // Detalhe de produtos dentro do grupo: EI, Compras, EF por produto
      var prodSet = {};
      var eiProds = ei.porProdGrupo[g] || {};
      var efProds = ef.porProdGrupo[g] || {};
      var coProds = (cMes && cMes.prodGrupo[g]) ? cMes.prodGrupo[g] : {};
      Object.keys(eiProds).forEach(function(p){ prodSet[p]=1; });
      Object.keys(efProds).forEach(function(p){ prodSet[p]=1; });
      Object.keys(coProds).forEach(function(p){ prodSet[p]=1; });

      var produtos = Object.keys(prodSet).map(function(p){
        var eiP = eiProds[p] || 0;
        var efP = efProds[p] || 0;
        var coObj = coProds[p] || { valor:0, qtd:0 };
        var coP = coObj.valor || 0;
        var qtdP = coObj.qtd || 0;
        return {
          nome: p,
          ei: r2(eiP), compras: r2(coP), ef: r2(efP),
          cmv: r2(eiP + coP - efP),
          qtd: r2(qtdP)
        };
      }).sort(function(a,b){ return b.cmv - a.cmv; });

      // Quantidade comprada do grupo = soma das quantidades dos produtos
      var qtdGrupo = produtos.reduce(function(s,p){ return s + (p.qtd || 0); }, 0);

      return {
        grupo: g,
        ei: r2(eiG), compras: r2(coG), ef: r2(efG),
        cmv: r2(eiG + coG - efG),
        qtd: r2(qtdGrupo),
        produtos: produtos
      };
    }).sort(function(a,b){ return b.cmv - a.cmv; });

    // CMV por filial
    var filiaisSet = {};
    Object.keys(ei.porFilial).forEach(function(f){ filiaisSet[f]=1; });
    Object.keys(ef.porFilial).forEach(function(f){ filiaisSet[f]=1; });
    if (cMes) Object.keys(cMes.filiais).forEach(function(f){ filiaisSet[f]=1; });

    var filiais = {};
    Object.keys(filiaisSet).forEach(function(f){
      var eiF = ei.porFilial[f] || 0;
      var efF = ef.porFilial[f] || 0;
      // coF já inclui as transferências recebidas (entrada) como compra.
      var coF = (cMes && cMes.filiais[f]) ? cMes.filiais[f].total : 0;
      // Transferência enviada por esta filial sai do componente de compras.
      var saidaTransf   = (cMes && cMes.saidaFilial && cMes.saidaFilial[f]) ? cMes.saidaFilial[f] : 0;
      var entradaTransf = (cMes && cMes.entradaFilial && cMes.entradaFilial[f]) ? cMes.entradaFilial[f] : 0;
      // coF ja inclui a entrada (transferencia recebida). Descontamos a saida (enviada).
      var comprasAjust = coF - saidaTransf;
      // CMV sem descontar a saída de transferência (usado no card de impacto)
      var cmvSemAjuste = eiF + coF - efF;
      // CMV totalmente sem transferência: compra externa pura, sem entrada nem saída.
      var comprasPuro = coF - entradaTransf;
      var cmvPuro = eiF + comprasPuro - efF;
      // ── Grupos desta filial ──
      var eiPorGrupoF = (ei.porFilialGrupo && ei.porFilialGrupo[f]) ? ei.porFilialGrupo[f] : {};
      var efPorGrupoF = (ef.porFilialGrupo && ef.porFilialGrupo[f]) ? ef.porFilialGrupo[f] : {};
      var coPorGrupoF = (cMes && cMes.filiais[f] && cMes.filiais[f].grupos) ? cMes.filiais[f].grupos : {};
      var entradaGrupoF = (cMes && cMes.entradaFilialGrupo && cMes.entradaFilialGrupo[f]) ? cMes.entradaFilialGrupo[f] : {};
      var saidaGrupoF   = (cMes && cMes.saidaFilialGrupo   && cMes.saidaFilialGrupo[f])   ? cMes.saidaFilialGrupo[f]   : {};

      var gruposSetF = {};
      Object.keys(eiPorGrupoF).forEach(function(g){ gruposSetF[g]=1; });
      Object.keys(efPorGrupoF).forEach(function(g){ gruposSetF[g]=1; });
      Object.keys(coPorGrupoF).forEach(function(g){ gruposSetF[g]=1; });
      Object.keys(entradaGrupoF).forEach(function(g){ gruposSetF[g]=1; });
      Object.keys(saidaGrupoF).forEach(function(g){ gruposSetF[g]=1; });

      var prodGrupoFilialF = (cMes && cMes.filiais[f] && cMes.filiais[f].prodGrupo) ? cMes.filiais[f].prodGrupo : {};
      var eiProdGrupoF = (ei.porProdGrupoFilial && ei.porProdGrupoFilial[f]) ? ei.porProdGrupoFilial[f] : {};
      var efProdGrupoF = (ef.porProdGrupoFilial && ef.porProdGrupoFilial[f]) ? ef.porProdGrupoFilial[f] : {};

      var gruposF = Object.keys(gruposSetF).map(function(g){
        var eiG = eiPorGrupoF[g] || 0;
        var efG = efPorGrupoF[g] || 0;
        var coG = coPorGrupoF[g] || 0;
        var entradaG = (entradaGrupoF[g] ? entradaGrupoF[g].valor : 0) || 0;
        var saidaG   = (saidaGrupoF[g]   ? saidaGrupoF[g].valor   : 0) || 0;
        var entradaQtdG = (entradaGrupoF[g] ? entradaGrupoF[g].qtd : 0) || 0;
        var saidaQtdG   = (saidaGrupoF[g]   ? saidaGrupoF[g].qtd   : 0) || 0;
        var coGAjust = coG - saidaG;  // coG já inclui a entrada; desconta a saída

        // Produtos do grupo, dentro desta filial.
        // Inclui produtos com estoque, compra OU movimentacao de transferencia,
        // para a soma dos produtos bater exatamente com o total do grupo.
        var prodSetG = {};
        var eiProdsG = (eiProdGrupoF[g]) || {};
        var efProdsG = (efProdGrupoF[g]) || {};
        var coProdsG = (prodGrupoFilialF[g]) || {};
        var entradaProdG = (cMes && cMes.entradaProdGrupoFilial && cMes.entradaProdGrupoFilial[f] && cMes.entradaProdGrupoFilial[f][g]) ? cMes.entradaProdGrupoFilial[f][g] : {};
        var saidaProdG   = (cMes && cMes.saidaProdGrupoFilial   && cMes.saidaProdGrupoFilial[f]   && cMes.saidaProdGrupoFilial[f][g])   ? cMes.saidaProdGrupoFilial[f][g]   : {};
        Object.keys(eiProdsG).forEach(function(p){ prodSetG[p]=1; });
        Object.keys(efProdsG).forEach(function(p){ prodSetG[p]=1; });
        Object.keys(coProdsG).forEach(function(p){ prodSetG[p]=1; });
        Object.keys(entradaProdG).forEach(function(p){ prodSetG[p]=1; });
        Object.keys(saidaProdG).forEach(function(p){ prodSetG[p]=1; });

        var produtosG = Object.keys(prodSetG).map(function(p){
          var eiP = eiProdsG[p] || 0;
          var efP = efProdsG[p] || 0;
          var coObjP = coProdsG[p] || { valor:0, qtd:0 };
          var coP = coObjP.valor || 0;   // já inclui a entrada, se esta filial recebeu o produto
          var qtdP = coObjP.qtd || 0;
          var entObjP = entradaProdG[p] || { valor:0, qtd:0 };
          var saiObjP = saidaProdG[p]   || { valor:0, qtd:0 };
          // Compras líquidas do produto: desconta apenas a saída (a entrada já está em coP)
          var coPLiquido = coP - (saiObjP.valor || 0);
          return {
            nome: p,
            ei: r2(eiP), compras: r2(coPLiquido), ef: r2(efP),
            cmv: r2(eiP + coPLiquido - efP),
            qtd: r2(qtdP),
            transf_entrada: r2(entObjP.valor||0), transf_entrada_qtd: r2(entObjP.qtd||0),
            transf_saida:   r2(saiObjP.valor||0), transf_saida_qtd:   r2(saiObjP.qtd||0)
          };
        }).sort(function(a,b){ return b.cmv - a.cmv; });

        return {
          grupo: g,
          ei: r2(eiG), compras: r2(coGAjust), ef: r2(efG),
          cmv: r2(eiG + coGAjust - efG),
          qtd: r2(produtosG.reduce(function(s,p){ return s + (p.qtd||0); }, 0)),
          transf_entrada: r2(entradaG), transf_entrada_qtd: r2(entradaQtdG),
          transf_saida:   r2(saidaG),   transf_saida_qtd:   r2(saidaQtdG),
          produtos: produtosG
        };
      }).sort(function(a,b){ return b.cmv - a.cmv; });

      filiais[f] = {
        ei: r2(eiF), compras: r2(comprasAjust), ef: r2(efF),
        cmv: r2(eiF + comprasAjust - efF), cmv_pct: null, faturamento: 0,
        cmv_sem_ajuste: r2(cmvSemAjuste),
        compras_puro: r2(comprasPuro),
        cmv_puro: r2(cmvPuro),
        transf_entrada: r2(entradaTransf),
        transf_saida:   r2(saidaTransf),
        transf_saldo:   r2(entradaTransf - saidaTransf),
        grupos: gruposF
      };
    });

    if (cmv[mesNome]) {
      Logger.log('AVISO: ja existe CMV calculado para ' + mesNome + ' — os dados do periodo ' +
                  tsEI + ' a ' + tsEF + ' vao substituir o calculo anterior. Isso indica mais de ' +
                  'duas contagens de estoque terminando no mesmo mes; confira se e intencional.');
    }
    cmv[mesNome] = {
      ei_total:      r2(ei.total),
      ef_total:      r2(ef.total),
      compras_total: r2(compras),
      cmv_total:     r2(cmvReal),
      cmv_pct:       null,
      faturamento:   0,
      data_ei:       tsEI.slice(6,8)+'/'+tsEI.slice(4,6)+'/'+tsEI.slice(0,4),
      data_ef:       tsEF.slice(6,8)+'/'+tsEF.slice(4,6)+'/'+tsEF.slice(0,4),
      grupos:        grupos,
      filiais:       filiais
    };

    Logger.log('CMV ' + mesNome + ': EI=' + r2(ei.total) + ' Compras=' + r2(compras) +
               ' EF=' + r2(ef.total) + ' CMV=' + r2(cmvReal));
  }

  return cmv;
}

// ── PROCESSAR FICHA TÉCNICA → CMV TEÓRICO ────────────────────
//
// Relatório de Detalhes de Fabricação do Cloudfy: para cada produto vendido,
// lista os insumos da receita com quantidade e custo. O "Custo unit." do
// produto (coluna 6) já vem somado a partir dos insumos — não precisamos
// reprocessar a receita, só ler esse valor por produto.
//
// ÍNDICES DO CSV DE FICHA TÉCNICA:
var C_FICHAS = {
  produto:    1,   // Nome do produto (ou insumo/preparo)
  tipo:       3,   // "Venda" (produto final) ou "Matéria prima" (preparo interno)
  rendimento: 5,   // Quantas unidades do produto UMA receita/lote produz
  custo_unit: 6,   // Custo unitário teórico do produto, já somando os insumos
  insumo_nome:       12,  // Nome do insumo usado nesta linha da receita
  insumo_qtde:       13,  // Quantidade do insumo por LOTE (não por unidade vendida)
  insumo_und:        14,  // Unidade do insumo
  insumo_custo_unit: 15   // Custo unitário do insumo
};

// Produtos de "menu de escolha livre" (o cliente escolhe o prato dentro do
// menu na hora, e o Cloudfy dá baixa de estoque no prato REAL escolhido —
// não no menu em si). Por isso nunca vai existir ficha técnica própria pra
// esses produtos: o custo real deles já está 100% capturado no CMV Real
// (via baixa de estoque do prato escolhido), só não é possível atribuir
// teoricamente por item porque a venda registra o nome do menu, não o prato.
// Isso é DIFERENTE de um produto sem ficha cadastrada por lacuna de
// cadastro — aqui não há o que cadastrar.
// Configurável pela tela (Ajustes > Configurações) — ver
// obterProdutosMenuEscolha()/salvarProdutosMenuEscolha() em Código.js.
// Valor PADRÃO usado só se ainda não foi configurado nada pela tela.
var PRODUTOS_MENU_ESCOLHA_PADRAO = [
  'MENU DA AMAZONIA', 'MENU PREMIUM', 'MENU CLASSICO', 'BANQUETE PARAENSE',
  'MENU TRADICIONAL', 'MENU SAIA RODADA', 'MENU PESCADOR',
  'SOBREMESA MENU PREMIUM', 'MENU DE SOBREMESAS'
];

// Retorna um mapa { "NOME DO PRODUTO": custo_unit_teorico }.
// Pega o PRIMEIRO custo encontrado por produto (o valor se repete em toda
// linha de insumo do mesmo produto, então a primeira ocorrência já serve).
function processarFichas(rows) {
  var mapa = {};
  if (!rows || rows.length < 2) return mapa;

  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r || r.length < 7) continue;

    var produto = limpaCelula(r[C_FICHAS.produto]);
    if (!produto || mapa[produto] !== undefined) continue;

    var custo = numVal(r[C_FICHAS.custo_unit]);
    mapa[produto] = custo;
  }

  Logger.log('Ficha técnica processada: ' + Object.keys(mapa).length + ' produtos com custo teórico.');
  return mapa;
}

// ── DEMANDA DE INSUMOS (explosão de receita) ──────────────────
//
// Diferente de processarFichas (que só guarda o custo unitário já somado
// de cada produto), aqui lemos a receita COMPLETA: rendimento e a lista de
// insumos de cada produto/preparo. Isso permite responder "quanto de cada
// matéria-prima eu precisei pra cobrir o que vendi", explodindo preparos
// internos (tipo "Matéria prima" que também têm ficha própria, ex: "PP
// FAROFA KG") recursivamente até chegar na matéria-prima real.
//
// Retorna um mapa { "NOME DO PRODUTO": { tipo, rendimento, custo_unit, insumos:[...] } }.
function processarReceitas(rows) {
  var receitas = {};
  if (!rows || rows.length < 2) return receitas;

  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r || r.length < 16) continue;

    var produto = limpaCelula(r[C_FICHAS.produto]);
    if (!produto) continue;

    if (!receitas[produto]) {
      receitas[produto] = {
        tipo:       limpaCelula(r[C_FICHAS.tipo]),
        rendimento: numVal(r[C_FICHAS.rendimento]) || 1,
        custo_unit: numVal(r[C_FICHAS.custo_unit]),
        insumos:    []
      };
    }

    var insumoNome = limpaCelula(r[C_FICHAS.insumo_nome]);
    var insumoQtde = numVal(r[C_FICHAS.insumo_qtde]);
    if (insumoNome && insumoQtde > 0) {
      receitas[produto].insumos.push({
        nome:       insumoNome,
        und:        limpaCelula(r[C_FICHAS.insumo_und]),
        qtde:       insumoQtde,
        custo_unit: numVal(r[C_FICHAS.insumo_custo_unit])
      });
    }
  }

  Logger.log('Receitas processadas: ' + Object.keys(receitas).length + ' produtos com lista de insumos.');
  return receitas;
}

// Retorna o conjunto de nomes que são, em ALGUMA receita da ficha técnica,
// um insumo-folha (matéria-prima real, sem ficha própria pra explodir mais).
// Usado pra restringir a reconciliação de insumos (Estoque x Compras x
// Teórico) só a itens que fazem sentido como insumo — sem isso, a lista
// fica poluída com embalagens, descartáveis e bebidas revendidas prontas
// que aparecem nas compras/contagens mas nunca são insumo de receita nenhuma.
function todosInsumosFolha(receitas) {
  var folhas = {};
  Object.keys(receitas).forEach(function(p) {
    receitas[p].insumos.forEach(function(ins) {
      var sub = receitas[ins.nome];
      var ehFolha = !sub || !sub.insumos.length;
      if (ehFolha) folhas[ins.nome] = true;
    });
  });
  return folhas;
}

// Explode UM produto vendido nos insumos da sua receita. Quando um insumo é,
// ele mesmo, um preparo interno com ficha própria (ex: uma "CG" que usa "PP
// FAROFA KG"), a quantidade necessária desse preparo é registrada em
// "preparos" (o que precisa ser PRODUZIDO) e a explosão continua recursivamente
// pra dentro dele, até sobrar só matéria-prima real em "materiasPrimas" (o
// que precisa ser COMPRADO). "cadeia" evita loop infinito se algum dia
// houver referência circular entre receitas.
function explodirInsumos(receitas, produtoNome, qtdeNecessaria, materiasPrimas, preparos, cadeia) {
  var receita = receitas[produtoNome];
  if (!receita || !receita.insumos.length) return;
  if (cadeia.indexOf(produtoNome) >= 0) return;
  var novaCadeia = cadeia.concat([produtoNome]);

  var rendimento = receita.rendimento || 1;
  var lotes = qtdeNecessaria / rendimento;

  receita.insumos.forEach(function(ins) {
    var qtdeInsumo = lotes * ins.qtde;
    var subReceita = receitas[ins.nome];
    var ehPreparoComReceita = subReceita && subReceita.insumos.length > 0;

    if (ehPreparoComReceita) {
      if (!preparos[ins.nome]) preparos[ins.nome] = { nome: ins.nome, und: ins.und, qtde: 0, custo_unit: ins.custo_unit };
      preparos[ins.nome].qtde += qtdeInsumo;
      explodirInsumos(receitas, ins.nome, qtdeInsumo, materiasPrimas, preparos, novaCadeia);
    } else {
      if (!materiasPrimas[ins.nome]) materiasPrimas[ins.nome] = { nome: ins.nome, und: ins.und, qtde: 0, custo_unit: ins.custo_unit };
      materiasPrimas[ins.nome].qtde += qtdeInsumo;
    }
  });
}

// Calcula a demanda de insumos por mês (e por filial) a partir das vendas
// reais do período — só considera produtos com ficha técnica cadastrada
// (mesma limitação do CMV Teórico: menus de escolha livre e itens sem ficha
// não entram, porque não há receita pra explodir).
function calcularDemandaInsumos(vendas, receitas) {
  var resultado = {};
  if (!vendas || !vendas.abc_mes || !receitas || !Object.keys(receitas).length) return resultado;

  function finalizarLista(mapa) {
    var lista = Object.keys(mapa).map(function(k) {
      var it = mapa[k];
      var qtde = r4(it.qtde);
      return { nome: it.nome, und: it.und, qtde: qtde, custo_unit: r4(it.custo_unit), custo_total: r2(qtde * it.custo_unit) };
    }).sort(function(a, b) { return b.custo_total - a.custo_total; });
    var total = lista.reduce(function(s, it) { return s + it.custo_total; }, 0);
    return { itens: lista, total: r2(total) };
  }

  function processarLista(produtosVendidos) {
    var materiasPrimas = {}, preparos = {};
    produtosVendidos.forEach(function(p) {
      if (receitas[p.produto]) {
        explodirInsumos(receitas, p.produto, p.qtd, materiasPrimas, preparos, []);
      }
    });
    return { materias_primas: finalizarLista(materiasPrimas), preparos: finalizarLista(preparos) };
  }

  Object.keys(vendas.abc_mes).forEach(function(mes) {
    var base = processarLista(vendas.abc_mes[mes].produtos);
    base.filiais = {};
    if (vendas.abc_mes_filial[mes]) {
      Object.keys(vendas.abc_mes_filial[mes]).forEach(function(fil) {
        base.filiais[fil] = processarLista(vendas.abc_mes_filial[mes][fil].produtos);
      });
    }
    resultado[mes] = base;
  });

  return resultado;
}

// ── CMV TEÓRICO REPRECIFICADO PELO CUSTO REAL DE COMPRA DO MÊS ──────────
//
// O "Custo unit." que vem na ficha técnica é uma FOTO do momento do envio —
// não varia mês a mês, mesmo que o preço do insumo tenha mudado de verdade.
// Pra refletir a variação real, cada insumo da receita é reprecificado pelo
// CUSTO MÉDIO PONDERADO de compra daquele insumo NO PRÓPRIO MÊS da venda
// (total comprado ÷ quantidade comprada). Se não houve compra daquele
// insumo no mês, usa o mês anterior mais próximo que teve compra (e assim
// sucessivamente, só olhando pra trás). Se o insumo nunca foi comprado (sem
// nenhum histórico), cai no custo registrado na própria ficha técnica —
// nunca fica sem preço nenhum.

// Pré-agrega o custo médio ponderado de cada insumo por mês/ano — uma
// única vez (mesma lógica de performance da Análise Quinzenal: evita
// reescanear rowsCompras a cada produto/mês). Ignora transferência entre
// unidades (não é preço de mercado, é só movimento de estoque).
function preAgregarCustoMedioPorInsumo(rowsCompras) {
  var porProdutoMes = {};
  if (!rowsCompras || rowsCompras.length < 2) return {};

  for (var i = 1; i < rowsCompras.length; i++) {
    var r = rowsCompras[i];
    if (!r || r.length < 18) continue;
    var custoUnit = numVal(r[C_COMPRAS.custo_atual]);
    var total = numVal(r[C_COMPRAS.total]);
    var qtd = numVal(r[C_COMPRAS.qtd]);
    if (custoUnit <= 0 || total <= 0 || qtd <= 0) continue;

    var dataInfo = parseDataCompleta(r[C_COMPRAS.data]);
    if (!dataInfo) continue;

    var filial = limpaCelula(r[C_COMPRAS.filial]) || 'OUTRA';
    var fornecedor = limpaCelula(r[C_COMPRAS_FORNECEDOR]);
    var pareceTransf = fornecedor.toUpperCase().indexOf(TRANSFERENCIA_MARCADOR) >= 0;
    var filOrig = pareceTransf ? filialOrigem(fornecedor) : null;
    var ehTransf = pareceTransf && filOrig !== filial;
    if (ehTransf) continue;

    var produto = limpaCelula(r[C_COMPRAS.produto]);
    if (!produto) continue;

    var chave = produto + '|' + dataInfo.ano + '|' + dataInfo.mes;
    if (!porProdutoMes[chave]) porProdutoMes[chave] = { produto: produto, ano: dataInfo.ano, mes: dataInfo.mes, totalValor: 0, totalQtd: 0 };
    porProdutoMes[chave].totalValor += total;
    porProdutoMes[chave].totalQtd += qtd;
  }

  var porInsumo = {};
  Object.keys(porProdutoMes).forEach(function(chave) {
    var e = porProdutoMes[chave];
    if (!porInsumo[e.produto]) porInsumo[e.produto] = [];
    porInsumo[e.produto].push({ ano: e.ano, mes: e.mes, custoUnit: r4(e.totalValor / e.totalQtd) });
  });
  Object.keys(porInsumo).forEach(function(produto) {
    porInsumo[produto].sort(function(a, b) { return (a.ano * 12 + a.mes) - (b.ano * 12 + b.mes); });
  });
  return porInsumo;
}

// Acha o custo médio de compra de um insumo num mês/ano específico, com
// fallback pro mês anterior mais próximo que teve compra — só olha pra
// trás, nunca pra frente ("mês anterior e assim sucessivamente").
function buscarCustoInsumoComFallback(historicoPorInsumo, insumoNome, mesNome, ano) {
  var lista = historicoPorInsumo[insumoNome];
  if (!lista || !lista.length) return null;
  var idxMes = ORDEM_MESES.indexOf(mesNome);
  if (idxMes < 0) return null;
  var alvoOrdinal = ano * 12 + (idxMes + 1);

  var melhor = null, melhorOrdinal = -Infinity;
  lista.forEach(function(e) {
    var ordinal = e.ano * 12 + e.mes;
    if (ordinal <= alvoOrdinal && ordinal > melhorOrdinal) { melhor = e; melhorOrdinal = ordinal; }
  });
  return melhor ? melhor.custoUnit : null;
}

// Explode a receita de UM produto (recursivamente, mesma lógica de
// explodirInsumos) e soma o custo usando o preço de compra de cada insumo
// NO MÊS (com fallback pro mês anterior); quando o insumo nunca foi
// comprado, cai no custo registrado na própria ficha técnica pra aquele
// insumo. Retorna o custo TOTAL pra "qtdeNecessaria" unidades do produto,
// ou null se o produto não tiver receita nenhuma (sem ficha).
function calcularCustoExplodido(receitas, produtoNome, qtdeNecessaria, mesNome, ano, historicoPorInsumo, cadeia) {
  var receita = receitas[produtoNome];
  if (!receita || !receita.insumos.length) return null;
  if (cadeia.indexOf(produtoNome) >= 0) return 0; // guarda contra ciclo

  var novaCadeia = cadeia.concat([produtoNome]);
  var rendimento = receita.rendimento || 1;
  var lotes = qtdeNecessaria / rendimento;
  var custoTotal = 0;

  receita.insumos.forEach(function(ins) {
    var qtdeInsumo = lotes * ins.qtde;
    var subReceita = receitas[ins.nome];
    var ehPreparoComReceita = subReceita && subReceita.insumos.length > 0;

    if (ehPreparoComReceita) {
      var subCusto = calcularCustoExplodido(receitas, ins.nome, qtdeInsumo, mesNome, ano, historicoPorInsumo, novaCadeia);
      custoTotal += (subCusto !== null) ? subCusto : (ins.custo_unit * qtdeInsumo);
    } else {
      var custoReal = buscarCustoInsumoComFallback(historicoPorInsumo, ins.nome, mesNome, ano);
      var custoUnit = (custoReal !== null) ? custoReal : ins.custo_unit; // fallback final: ficha técnica
      custoTotal += custoUnit * qtdeInsumo;
    }
  });

  return custoTotal;
}

// Calcula o CMV Teórico por mês (e por filial): para cada produto vendido,
// quantidade vendida × custo unitário teórico — reprecificado pelo custo
// real de compra do mês quando o produto tem receita completa (ver
// calcularCustoExplodido acima); cai no valor estático da ficha técnica
// quando não dá pra reprecificar (produto sem estrutura de receita, ou mês
// sem ano identificável).
// Produtos vendidos SEM ficha técnica cadastrada não entram no teórico —
// o valor dessas vendas fica separado em "sem_ficha_valor" para deixar
// claro que o teórico pode estar subestimado nesse caso.
function calcularCMVTeorico(vendas, fichasMap, produtosMenuEscolha, receitas, historicoPorInsumo, anoPorMes) {
  var resultado = {};
  if (!vendas || !vendas.abc_mes || !fichasMap || !Object.keys(fichasMap).length) return resultado;

  // Se nao vier configurado (Script Properties), cai no padrao.
  var listaMenu = (produtosMenuEscolha && produtosMenuEscolha.length) ? produtosMenuEscolha : PRODUTOS_MENU_ESCOLHA_PADRAO;
  var produtosMenuSet = {};
  listaMenu.forEach(function(nome) { produtosMenuSet[String(nome).toUpperCase()] = true; });

  // Custo unitário teórico de UM produto NO MÊS: se der pra explodir a
  // receita (produtosMenuSet/fichasMap já garantem que so chega aqui quem
  // tem ficha), reprecifica pelo custo real de compra do mês; senão cai no
  // valor estático da ficha técnica (fallback final).
  function custoUnitarioNoMes(produtoNome, mesNome, ano) {
    if (!receitas || !receitas[produtoNome] || !mesNome || !ano) return fichasMap[produtoNome];
    var custoTotal = calcularCustoExplodido(receitas, produtoNome, 1, mesNome, ano, historicoPorInsumo || {}, []);
    return (custoTotal !== null) ? custoTotal : fichasMap[produtoNome];
  }

  // Detalha por produto (usado tanto pro total do mes quanto pra tabela por
  // produto na tela) — cada linha mostra se bateu ou nao com a ficha tecnica.
  function detalharProdutos(produtos, mesNome, ano) {
    var teorico = 0, semFichaCadastro = 0, semFichaMenu = 0;
    var lista = produtos.map(function(p) {
      var temFicha  = fichasMap[p.produto] !== undefined;
      var ehMenuEscolha = !temFicha && !!produtosMenuSet[String(p.produto || '').toUpperCase()];
      var custoUnit = temFicha ? custoUnitarioNoMes(p.produto, mesNome, ano) : undefined;
      var custoTotal = temFicha ? r2(custoUnit * p.qtd) : null;
      if (temFicha) teorico += custoUnit * p.qtd;
      else if (ehMenuEscolha) semFichaMenu += p.valor;
      else semFichaCadastro += p.valor;
      return {
        produto: p.produto,
        grupo: p.grupo,
        qtd: p.qtd,
        valor_vendido: p.valor,
        custo_unit_teorico: temFicha ? r4(custoUnit) : null,
        custo_total_teorico: custoTotal,
        tem_ficha: temFicha,
        menu_escolha: ehMenuEscolha
      };
    }).sort(function(a, b) { return (b.custo_total_teorico || 0) - (a.custo_total_teorico || 0); });
    return {
      teorico_total: r2(teorico),
      sem_ficha_valor: r2(semFichaCadastro + semFichaMenu),
      sem_ficha_valor_cadastro: r2(semFichaCadastro),
      sem_ficha_valor_menu: r2(semFichaMenu),
      produtos: lista
    };
  }

  Object.keys(vendas.abc_mes).forEach(function(mes) {
    var ano = anoPorMes ? anoPorMes[mes] : null;
    var base = detalharProdutos(vendas.abc_mes[mes].produtos, mes, ano);
    base.filiais = {};

    if (vendas.abc_mes_filial[mes]) {
      Object.keys(vendas.abc_mes_filial[mes]).forEach(function(fil) {
        base.filiais[fil] = detalharProdutos(vendas.abc_mes_filial[mes][fil].produtos, mes, ano);
      });
    }

    resultado[mes] = base;
  });

  // Diagnostico: para os produtos mais vendidos, mostra se o nome EXATO
  // existe na ficha tecnica ou nao — mais direto que comparar amostras
  // aleatorias (que podem ser produtos diferentes por coincidencia).
  if (vendas.abc_geral && vendas.abc_geral.length) {
    Logger.log('CMV Teorico - checagem dos produtos mais vendidos:');
    vendas.abc_geral.slice(0, 15).forEach(function(p) {
      var bate = fichasMap[p.produto] !== undefined;
      Logger.log('  [' + (bate ? 'OK' : 'SEM FICHA') + '] "' + p.produto + '"');
    });
  }

  return resultado;
}

// ============================================================
//  ANÁLISE QUINZENAL (CMC + CMV) — dia 1 a dia 15 do mês
// ============================================================
//
// Objetivo: dar visibilidade de meio de mês sobre custo, comparando com
// meses anteriores, projetando o fechamento e gerando alertas/diagnóstico.
//
// CMC Quinzenal (Compras ÷ Vendas) é sempre calculável — não depende de
// contagem de estoque, só de compras e vendas, que têm data exata em cada
// linha do CSV.
//
// CMV Quinzenal usa a MESMA metodologia já existente (EI + Compras − EF):
//   - EI = o mesmo Estoque Inicial já calculado por processarCMV pro mês
//     inteiro (é o mesmo ponto de partida — zero risco de divergência).
//   - Compras = soma real das compras do dia 1 ao dia 15 (dado exato).
//   - EF = a contagem de estoque mais próxima do dia 15, dentro de uma
//     janela de ±3 dias (dia 12 a 18), ajustada pelas compras REAIS
//     ocorridas entre a data da contagem e o dia 15.
//     Esse ajuste NÃO cobre saídas/consumo, porque o sistema não tem um
//     registro diário de baixa por insumo (só o consumo TEÓRICO via ficha
//     técnica, que é estimativa, não movimento real) — isso fica sempre
//     explícito no resultado, nunca escondido.
//   - Se não houver nenhuma contagem dentro da janela, o CMV Quinzenal fica
//     "não calculado" (nunca inventa um Estoque Final).
//
// Todas as funções desta seção são PURAS: recebem os dados já lidos
// (rowsCompras, rowsVendas, rowsEstoque, o "cmv" já calculado por
// processarCMV) e não fazem nenhuma leitura adicional de Drive/Planilha —
// zero I/O repetido, conforme a metodologia de performance do sistema.

var QUINZENAL_DIA_CORTE   = 15;  // corte da quinzena
var QUINZENAL_JANELA_DIAS = 3;   // contagem elegível pro EF: dia 12 a 18 (15 ± 3)
var META_PADRAO_PCT       = 40;  // fallback se a Script Property não estiver configurada

var ORDEM_MESES = ['JANEIRO','FEVEREIRO','MARÇO','ABRIL','MAIO','JUNHO',
                    'JULHO','AGOSTO','SETEMBRO','OUTUBRO','NOVEMBRO','DEZEMBRO'];

// Critérios de alerta centralizados — nada espalhado pelas funções de análise.
var ALERTA_CONFIG = {
  desvioCriticoPP:   5,    // desvio ACIMA da meta >= 5 p.p.        => CRITICO
  desvioAtencaoPP:   0,    // desvio ACIMA da meta >  0 p.p.        => ATENCAO (ou CRITICO se piorando)
  pressaoCriticaPP:  10,   // (var% compras − var% vendas) >= 10pp  => CRITICO
  pressaoAtencaoPP:  5,    // (var% compras − var% vendas) >= 5pp   => ATENCAO
  tendenciaLimitePP: 0.5   // variação mínima entre períodos p/ não considerar "ESTAVEL"
};

var ORDEM_GRAVIDADE = { 'CRITICO': 3, 'ATENCAO': 2, 'NORMAL': 1, 'POSITIVO': 0 };

// ── Utilitários de calendário ───────────────────────────────────

function diasNoMes(mesNome, ano) {
  var idx = ORDEM_MESES.indexOf(mesNome);
  if (idx < 0) return 30;
  return new Date(ano, idx + 1, 0).getDate();
}

// Retorna {mes, ano} do mês N meses ANTES de mesNome/ano (n=1 => mês anterior),
// cruzando virada de ano corretamente (ex: Janeiro/2027, n=1 => Dezembro/2026).
function mesAnoAnterior(mesNome, ano, n) {
  var idx = ORDEM_MESES.indexOf(mesNome);
  if (idx < 0) return null;
  var total = idx - n;
  var anoAjustado = ano + Math.floor(total / 12);
  var idxAjustado = ((total % 12) + 12) % 12;
  return { mes: ORDEM_MESES[idxAjustado], ano: anoAjustado };
}

// ── Coleta (pré-agrega linhas já lidas UMA VEZ — sem acesso a Drive) ────
//
// IMPORTANTE (performance): a Análise Quinzenal consulta compras/vendas de
// vários períodos (mês atual + até 3 anteriores + até 6 meses de histórico
// pra projeção) — reescanear os arrays inteiros de compras/vendas (que têm
// dezenas de milhares de linhas) a cada consulta deixava o carregamento
// lento (chegou a 90+ segundos em teste real). Por isso os dados são
// pré-agregados por DIA uma única vez (preAgregarComprasPorDia /
// preAgregarVendasPorDia), e toda consulta de período vira apenas uma soma
// sobre, no máximo, 31 chaves já calculadas — não um novo scan das linhas.

function chaveDia(ano, mesNome, dia) { return ano + '|' + mesNome + '|' + dia; }

// Pré-agrega COMPRAS por dia — já aplica a lógica de transferência entre
// unidades EXATAMENTE como processarCompras/processarCMV: a filial de
// destino recebe normalmente, a de origem tem descontado o que enviou, e o
// consolidado nunca conta a transferência como compra nova (já foi contada
// na compra externa de origem).
function preAgregarComprasPorDia(rowsCompras) {
  var porDia = {};
  if (!rowsCompras || rowsCompras.length < 2) return porDia;

  for (var i = 1; i < rowsCompras.length; i++) {
    var r = rowsCompras[i];
    if (!r || r.length < 18) continue;
    var custoUnit = numVal(r[C_COMPRAS.custo_atual]);
    var total     = numVal(r[C_COMPRAS.total]);
    if (custoUnit <= 0 || total <= 0) continue;

    var dataInfo = parseDataCompleta(r[C_COMPRAS.data]);
    if (!dataInfo) continue;
    var mesNome = NOMES_MESES[dataInfo.mes];
    var chave = chaveDia(dataInfo.ano, mesNome, dataInfo.dia);
    if (!porDia[chave]) porDia[chave] = { total: 0, filiais: {} };
    var b = porDia[chave];

    var filial = limpaCelula(r[C_COMPRAS.filial]) || 'OUTRA';
    var fornecedor = limpaCelula(r[C_COMPRAS_FORNECEDOR]);
    var pareceTransf = fornecedor.toUpperCase().indexOf(TRANSFERENCIA_MARCADOR) >= 0;
    var filOrig = pareceTransf ? filialOrigem(fornecedor) : null;
    var ehTransf = pareceTransf && filOrig !== filial;

    if (!b.filiais[filial]) b.filiais[filial] = 0;
    b.filiais[filial] += total;

    if (ehTransf) {
      if (!b.filiais[filOrig]) b.filiais[filOrig] = 0;
      b.filiais[filOrig] -= total;
    } else {
      b.total += total;
    }
  }
  return porDia;
}

// Pré-agrega VENDAS por dia — exclui TAXAS OPERACIONAIS (mesma regra de processarVendas).
function preAgregarVendasPorDia(rowsVendas) {
  var porDia = {};
  if (!rowsVendas || rowsVendas.length < 2) return porDia;

  for (var i = 1; i < rowsVendas.length; i++) {
    var r = rowsVendas[i];
    if (!r || r.length < 15) continue;
    var grupo = limpaCelula(r[C_VENDAS.grupo]);
    var valor = numVal(r[C_VENDAS.valor]);
    if (valor <= 0) continue;
    if (GRUPOS_EXCLUIR_ABC.indexOf(grupo.toUpperCase()) >= 0) continue;

    var dataInfo = parseDataCompleta(r[C_VENDAS.data]);
    if (!dataInfo) continue;
    var mesNome = NOMES_MESES[dataInfo.mes];
    var chave = chaveDia(dataInfo.ano, mesNome, dataInfo.dia);
    if (!porDia[chave]) porDia[chave] = { total: 0, filiais: {} };
    var b = porDia[chave];

    var filial = limpaCelula(r[C_VENDAS.filial]) || 'OUTRA';
    if (!b.filiais[filial]) b.filiais[filial] = 0;
    b.filiais[filial] += valor;
    b.total += valor;
  }
  return porDia;
}

// Soma um intervalo de dias [diaMin, diaMax] a partir do pré-agregado
// (compras ou vendas — mesmo formato de saída de ambas as funções acima).
function somarPeriodoPreAgregado(porDia, mesNome, ano, diaMin, diaMax) {
  var total = 0, filiais = {};
  for (var dia = diaMin; dia <= diaMax; dia++) {
    var b = porDia[chaveDia(ano, mesNome, dia)];
    if (!b) continue;
    total += b.total;
    Object.keys(b.filiais).forEach(function(f) { filiais[f] = (filiais[f] || 0) + b.filiais[f]; });
  }
  Object.keys(filiais).forEach(function(f) { filiais[f] = r2(filiais[f]); });
  return { total: r2(total), filiais: filiais };
}

function buscarComprasQuinzenais(porDiaCompras, mesNome, ano, diaCorte) {
  return somarPeriodoPreAgregado(porDiaCompras, mesNome, ano, 1, diaCorte);
}

// Soma o total de compras do MÊS INTEIRO (dia 1 até o último dia do mês) —
// usado só pra calcular a proporção histórica quinzena/mês (projeção).
function somarComprasMesCompleto(porDiaCompras, mesNome, ano) {
  return somarPeriodoPreAgregado(porDiaCompras, mesNome, ano, 1, diasNoMes(mesNome, ano));
}

function buscarVendasQuinzenais(porDiaVendas, mesNome, ano, diaCorte) {
  return somarPeriodoPreAgregado(porDiaVendas, mesNome, ano, 1, diaCorte);
}

function somarVendasMesCompleto(porDiaVendas, mesNome, ano) {
  return somarPeriodoPreAgregado(porDiaVendas, mesNome, ano, 1, diasNoMes(mesNome, ano));
}

// Pré-agrega as contagens de estoque (linhas de Inventário) por ts (data) —
// uma única vez. Como só existem poucas datas de contagem no sistema todo
// (uma por mês, tipicamente), isso é barato e evita reescanear rowsEstoque
// pra cada mês analisado na Análise Quinzenal.
function preAgregarContagensPorTs(rowsEstoque) {
  var porTs = {};
  if (!rowsEstoque || rowsEstoque.length < 2) return porTs;

  for (var i = 1; i < rowsEstoque.length; i++) {
    var r = rowsEstoque[i];
    if (!r || r.length < 16) continue;
    if (limpaCelula(r[C_ESTOQUE.tp_movto]) !== ESTOQUE_TIPO_VALIDO) continue;
    var dataInfo = parseDataCompleta(r[C_ESTOQUE.data]);
    if (!dataInfo) continue;

    var valor = numVal(r[C_ESTOQUE.custo_total]);
    if (valor <= 0) continue;
    var filial = limpaCelula(r[C_ESTOQUE.filial]) || 'OUTRA';

    if (!porTs[dataInfo.ts]) porTs[dataInfo.ts] = { dia: dataInfo.dia, mes: dataInfo.mes, ano: dataInfo.ano, total: 0, filiais: {} };
    porTs[dataInfo.ts].total += valor;
    porTs[dataInfo.ts].filiais[filial] = (porTs[dataInfo.ts].filiais[filial] || 0) + valor;
  }
  return porTs;
}

// Acha, dentro do mês/ano, a contagem de estoque mais próxima do dia de
// corte (15), respeitando a janela configurada (QUINZENAL_JANELA_DIAS pra
// cada lado). Retorna o VALOR (R$) da contagem, consolidado e por filial, e
// metadados (data real, distância, confiança). Nunca finge que a contagem é
// do dia 15 — a data real sempre vai junto.
function acharContagemProximaDia15(porTsContagens, mesNome, ano, diaCorte) {
  if (!porTsContagens) return null;

  var tsCandidatos = Object.keys(porTsContagens).filter(function(ts) {
    var c = porTsContagens[ts];
    return c.ano === ano && NOMES_MESES[c.mes] === mesNome && Math.abs(c.dia - diaCorte) <= QUINZENAL_JANELA_DIAS;
  });
  if (!tsCandidatos.length) return null;

  tsCandidatos.sort(function(a, b) {
    var da = Math.abs(porTsContagens[a].dia - diaCorte), db = Math.abs(porTsContagens[b].dia - diaCorte);
    if (da !== db) return da - db;
    return a.localeCompare(b); // empate na distância: fica com a data mais antiga
  });

  var tsEscolhido = tsCandidatos[0];
  var c = porTsContagens[tsEscolhido];
  var distancia = Math.abs(c.dia - diaCorte);
  var filiaisArred = {};
  Object.keys(c.filiais).forEach(function(f) { filiaisArred[f] = r2(c.filiais[f]); });

  return {
    ts: tsEscolhido, dia: c.dia,
    data: tsEscolhido.slice(6,8) + '/' + tsEscolhido.slice(4,6) + '/' + tsEscolhido.slice(0,4),
    distancia: distancia,
    confianca: calcularConfianca(distancia),
    valor: r2(c.total),
    valorFiliais: filiaisArred
  };
}

function calcularConfianca(distanciaDias) {
  if (distanciaDias === 0 || distanciaDias === 1) return 'ALTA';
  if (distanciaDias === 2) return 'BOA';
  if (distanciaDias === 3) return 'MODERADA';
  return null;
}

// Ajusta o valor da contagem (que pode não ser exatamente do dia 15) pra uma
// referência no dia de corte, usando SOMENTE compras reais conhecidas no
// intervalo entre a contagem e o dia de corte. Não há como ajustar por
// saídas/consumo real porque o sistema não tem um registro diário de baixa
// por insumo (a baixa por venda só existe de forma TEÓRICA, via ficha
// técnica) — por isso o ajuste é parcial, e isso fica sempre explícito.
function ajustarContagemParaDia15(contagemInfo, porDiaCompras, mesNome, ano, diaCorte) {
  if (!contagemInfo) return null;
  var dia = contagemInfo.dia;
  var entradas = { total: 0, filiais: {} };
  var direcao = 'nenhum';

  if (dia < diaCorte) {
    entradas = somarPeriodoPreAgregado(porDiaCompras, mesNome, ano, dia + 1, diaCorte);
    direcao = 'soma';    // contagem foi ANTES do dia 15 -> soma compras do intervalo
  } else if (dia > diaCorte) {
    entradas = somarPeriodoPreAgregado(porDiaCompras, mesNome, ano, diaCorte + 1, dia);
    direcao = 'subtrai'; // contagem foi DEPOIS do dia 15 -> tira compras do intervalo
  }

  var sinal = direcao === 'subtrai' ? -1 : 1;
  var valorAjustado = r2(contagemInfo.valor + sinal * entradas.total);

  var valorFiliaisAjustado = {};
  Object.keys(contagemInfo.valorFiliais).forEach(function(f) {
    var entradaFil = entradas.filiais[f] || 0;
    valorFiliaisAjustado[f] = r2(contagemInfo.valorFiliais[f] + sinal * entradaFil);
  });
  Object.keys(entradas.filiais).forEach(function(f) {
    if (valorFiliaisAjustado[f] === undefined) valorFiliaisAjustado[f] = r2(sinal * entradas.filiais[f]);
  });

  return {
    valor: valorAjustado,
    valorFiliais: valorFiliaisAjustado,
    ajusteAplicado: direcao !== 'nenhum',
    entradasConsideradas: r2(entradas.total),
    diasAjustados: Math.abs(dia - diaCorte),
    obs: direcao === 'nenhum'
      ? 'Contagem realizada exatamente no dia ' + diaCorte + ' — nenhum ajuste necessário.'
      : 'Ajuste considera apenas compras reais registradas entre a contagem (dia ' + dia + ') e o dia ' +
        diaCorte + '. Não há registro diário de consumo/saída no sistema, então o valor pode estar levemente ' +
        (direcao === 'soma' ? 'superestimado' : 'subestimado') +
        ' se houve consumo relevante nesse intervalo curto.'
  };
}

// ── CMV Quinzenal (metodologia EI + Compras − EF já existente) ──────────

function calcularCMVQuinzenal(cmvMesCompleto, porTsContagens, porDiaCompras, mesNome, ano, diaCorte) {
  if (!cmvMesCompleto || cmvMesCompleto.ei_total === undefined) {
    return { disponivel: false, motivo: 'CMV do mês completo ainda não está disponível (precisa de duas contagens de estoque consecutivas envolvendo esse mês).' };
  }

  var contagem = acharContagemProximaDia15(porTsContagens, mesNome, ano, diaCorte);
  if (!contagem) {
    return {
      disponivel: false,
      motivo: 'Não há contagem de estoque entre os dias ' + (diaCorte - QUINZENAL_JANELA_DIAS) +
        ' e ' + (diaCorte + QUINZENAL_JANELA_DIAS) + ' de ' + mesNome.toLowerCase() + '/' + ano +
        '. O CMV Quinzenal não pode ser calculado sem uma contagem física próxima ao dia ' + diaCorte + '.'
    };
  }

  var ajuste = ajustarContagemParaDia15(contagem, porDiaCompras, mesNome, ano, diaCorte);
  var comprasQuinzenal = buscarComprasQuinzenais(porDiaCompras, mesNome, ano, diaCorte);

  var ei = cmvMesCompleto.ei_total;
  var ef = ajuste.valor;
  var cmvValor = r2(ei + comprasQuinzenal.total - ef);

  var porFilial = {};
  if (cmvMesCompleto.filiais) {
    Object.keys(cmvMesCompleto.filiais).forEach(function(fil) {
      var eiFil = cmvMesCompleto.filiais[fil].ei || 0;
      var efFil = ajuste.valorFiliais[fil] !== undefined ? ajuste.valorFiliais[fil] : null;
      var compFil = comprasQuinzenal.filiais[fil] || 0;
      if (efFil === null) return; // sem dado de contagem pra essa filial na data escolhida
      porFilial[fil] = { ei: r2(eiFil), compras: r2(compFil), ef: r2(efFil), cmv: r2(eiFil + compFil - efFil) };
    });
  }

  return {
    disponivel: true,
    ei: r2(ei), compras: comprasQuinzenal.total, ef: r2(ef), cmv: cmvValor,
    contagemData: contagem.data, contagemDia: contagem.dia,
    contagemDistanciaDias: contagem.distancia, confianca: contagem.confianca,
    ajusteAplicado: ajuste.ajusteAplicado, ajusteObs: ajuste.obs,
    entradasConsideradasNoAjuste: ajuste.entradasConsideradas,
    filiais: porFilial
  };
}

// ── CMC Quinzenal (Compras ÷ Vendas — sempre calculável) ─────────────────

function calcularPct(numerador, denominador) {
  if (!denominador || denominador <= 0) return null;
  return Math.round(numerador / denominador * 10000) / 100;
}

function calcularCMCQuinzenal(comprasQuinzenal, vendasQuinzenal) {
  var pct = calcularPct(comprasQuinzenal.total, vendasQuinzenal.total);
  var porFilial = {};
  Object.keys(vendasQuinzenal.filiais).forEach(function(fil) {
    var c = comprasQuinzenal.filiais[fil] || 0;
    var v = vendasQuinzenal.filiais[fil] || 0;
    porFilial[fil] = { compras: r2(c), vendas: r2(v), cmc_pct: calcularPct(c, v) };
  });
  return { compras: comprasQuinzenal.total, vendas: vendasQuinzenal.total, cmc_pct: pct, filiais: porFilial };
}

// ── Comparação, tendência, projeção ───────────────────────────────────────

// Desvio em pontos percentuais sobre a meta. Positivo = acima da meta (pior,
// já que CMC/CMV são indicadores de custo), negativo = abaixo (melhor).
function calcularDesvioPP(realizadoPct, metaPct) {
  if (realizadoPct === null || realizadoPct === undefined || metaPct === null || metaPct === undefined) return null;
  return r2(realizadoPct - metaPct);
}

function calcularVariacaoPct(atual, anterior) {
  if (atual === null || atual === undefined || !anterior) return null;
  return r2((atual - anterior) / anterior * 100);
}

// Tendência de uma série de percentuais (do mais antigo pro mais recente).
// Só aponta "MELHORA"/"PIORA" se a variação entre o primeiro e o último
// ponto ultrapassar o limite configurado — evita apontar tendência por causa
// de oscilação pequena entre dois períodos.
function calcularTendencia(seriePct) {
  var validos = (seriePct || []).filter(function(v) { return v !== null && v !== undefined; });
  if (validos.length < 2) return null;
  var diff = r2(validos[validos.length - 1] - validos[0]);
  if (Math.abs(diff) < ALERTA_CONFIG.tendenciaLimitePP) return 'ESTAVEL';
  return diff > 0 ? 'PIORA' : 'MELHORA'; // CMC/CMV subindo = piora (é custo)
}

function calcularPressaoCompras(varComprasPct, varVendasPct) {
  if (varComprasPct === null || varVendasPct === null) return { diferencaPP: null, nivel: null };
  var diferencaPP = r2(varComprasPct - varVendasPct);
  var nivel = 'NORMAL';
  if (diferencaPP >= ALERTA_CONFIG.pressaoCriticaPP) nivel = 'CRITICO';
  else if (diferencaPP >= ALERTA_CONFIG.pressaoAtencaoPP) nivel = 'ATENCAO';
  return { diferencaPP: diferencaPP, nivel: nivel };
}

// Projeção do fechamento do mês. Se houver histórico suficiente (>=2 meses
// fechados com proporção quinzena/mês calculável), usa a proporção HISTÓRICA
// média como fator de projeção — reflete o comportamento real do negócio em
// vez de assumir que as vendas se distribuem igual em todos os dias.
// Sem histórico suficiente, cai no método simples e transparente: valor
// quinzenal × (dias do mês ÷ dia de corte) — nunca um "× 2" cego.
function calcularProjecaoMensal(valorQuinzenal, mesNome, ano, diaCorte, proporcoesHistoricas) {
  var amostras = (proporcoesHistoricas || []).filter(function(p) { return p > 0; });
  if (amostras.length >= 2) {
    var soma = amostras.reduce(function(s, p) { return s + p; }, 0);
    var proporcaoMedia = soma / amostras.length;
    return {
      valor: r2(valorQuinzenal / proporcaoMedia),
      metodologia: 'historica',
      proporcaoUsada: r4(proporcaoMedia),
      amostras: amostras.length,
      descricao: 'Baseada na proporção histórica média entre o acumulado até o dia ' + diaCorte +
        ' e o total do mês, observada nos últimos ' + amostras.length + ' meses comparáveis (em média, ' +
        r2(proporcaoMedia * 100) + '% do mês já ocorre até o dia ' + diaCorte + ').'
    };
  }
  var dias = diasNoMes(mesNome, ano);
  return {
    valor: r2(valorQuinzenal * (dias / diaCorte)),
    metodologia: 'simples',
    proporcaoUsada: r4(diaCorte / dias),
    amostras: amostras.length,
    descricao: 'Histórico insuficiente (menos de 2 meses comparáveis com o mesmo corte) — projeção simples ' +
      'proporcional aos dias do mês (dia ' + diaCorte + ' de ' + dias + '), sem considerar sazonalidade.'
  };
}

// ── Alertas e diagnóstico ─────────────────────────────────────────────────

// Classifica o status de um indicador de custo (CMC ou CMV) frente à meta e
// à tendência. Critérios em ALERTA_CONFIG — nada espalhado pelo código.
function classificarStatusCusto(desvioPP, tendencia) {
  if (desvioPP === null || desvioPP === undefined) return null;
  if (desvioPP >= ALERTA_CONFIG.desvioCriticoPP) return 'CRITICO';
  if (desvioPP > ALERTA_CONFIG.desvioAtencaoPP) return (tendencia === 'PIORA') ? 'CRITICO' : 'ATENCAO';
  if (desvioPP < 0) return 'POSITIVO';
  return 'NORMAL';
}

function classificarStatusPressao(nivel) {
  if (nivel === 'CRITICO') return 'CRITICO';
  if (nivel === 'ATENCAO') return 'ATENCAO';
  if (!nivel) return null;
  return 'NORMAL';
}

// Pega o pior status entre os avaliados, na ordem CRITICO > ATENCAO > NORMAL > POSITIVO.
function diagnosticoGeral(statusList) {
  var validos = (statusList || []).filter(function(s) { return s; });
  if (!validos.length) return null;
  return validos.reduce(function(pior, atual) {
    return ORDEM_GRAVIDADE[atual] > ORDEM_GRAVIDADE[pior] ? atual : pior;
  });
}

// ── Análise gerencial textual (gerada só a partir dos dados calculados) ──

function fPPTxt(v) {
  if (v === null || v === undefined) return '--';
  return (v > 0 ? '+' : '') + r2(v).toFixed(1).replace('.', ',') + ' p.p.';
}
function fPctTxt(v) {
  if (v === null || v === undefined) return '--';
  return r2(v).toFixed(1).replace('.', ',') + '%';
}

// d: { pct, metaPct, desvioPP, status, tendencia, mesAnteriorNome, varAnteriorPP,
//      varComprasPct, varVendasPct, pressao, projecaoPct, cmvQuinzenal }
function gerarAnaliseGerencialCMV(mesNome, ano, d) {
  if (!d.cmvQuinzenal || !d.cmvQuinzenal.disponivel) {
    return 'CMV Quinzenal de ' + mesNome.toLowerCase() + '/' + ano + ' não pôde ser calculado: ' +
      (d.cmvQuinzenal ? d.cmvQuinzenal.motivo : 'dados insuficientes.') +
      ' O CMC Quinzenal apresentado abaixo não depende de contagem de estoque e continua válido.';
  }

  var partes = [];
  partes.push('O CMV acumulado até o dia ' + QUINZENAL_DIA_CORTE + ' está em ' + fPctTxt(d.pct) +
    (d.desvioPP === null ? '.' :
      d.desvioPP > 0 ? ', acima da meta de ' + fPctTxt(d.metaPct) + ', representando um desvio de ' + fPPTxt(d.desvioPP) + '.' :
      d.desvioPP < 0 ? ', abaixo da meta de ' + fPctTxt(d.metaPct) + ', com folga de ' + fPPTxt(-d.desvioPP) + '.' :
      ', exatamente na meta de ' + fPctTxt(d.metaPct) + '.'));

  if (d.varAnteriorPP !== null && d.varAnteriorPP !== undefined && d.mesAnteriorNome) {
    partes.push('Em comparação com ' + d.mesAnteriorNome.toLowerCase() + ', o CMV ' +
      (d.varAnteriorPP > 0 ? 'aumentou ' + fPPTxt(d.varAnteriorPP).replace('+','') :
       d.varAnteriorPP < 0 ? 'reduziu ' + fPPTxt(-d.varAnteriorPP).replace('+','') : 'ficou estável') +
      (d.varAnteriorPP !== 0 ? (d.varAnteriorPP > 0 ? ', indicando deterioração do indicador.' : ', indicando melhora do indicador.') : '.'));
  }

  if (d.varComprasPct !== null && d.varComprasPct !== undefined && d.varVendasPct !== null && d.varVendasPct !== undefined) {
    partes.push('As compras ' + (d.varComprasPct >= 0 ? 'cresceram ' + fPctTxt(d.varComprasPct) : 'caíram ' + fPctTxt(-d.varComprasPct)) +
      ' enquanto as vendas ' + (d.varVendasPct >= 0 ? 'cresceram apenas ' + fPctTxt(d.varVendasPct) : 'caíram ' + fPctTxt(-d.varVendasPct)) +
      (d.pressao && d.pressao.nivel && d.pressao.nivel !== 'NORMAL'
        ? ', indicando que o crescimento das compras está acima do crescimento das vendas.'
        : '.'));
  }

  if (d.projecaoPct !== null && d.projecaoPct !== undefined) {
    partes.push('Mantido o comportamento atual, o CMV projetado para o fechamento do mês é de aproximadamente ' + fPctTxt(d.projecaoPct) + '.');
  }

  if (d.status === 'CRITICO' || d.status === 'ATENCAO') {
    partes.push('Ponto de atenção: ' + (d.pressao && d.pressao.nivel && d.pressao.nivel !== 'NORMAL'
      ? 'o ritmo de compras está acima do ritmo de vendas e pode pressionar o CMV no fechamento.'
      : 'o CMV está acima da meta e merece acompanhamento até o fechamento do mês.'));
    partes.push('Recomendação: revisar compras, estoque e possíveis perdas/desvios antes do fechamento do mês.');
  }

  return partes.join(' ');
}

function gerarAnaliseGerencialCMC(mesNome, ano, d) {
  var partes = [];
  partes.push('Até o dia ' + QUINZENAL_DIA_CORTE + ', as compras representam ' + fPctTxt(d.pct) + ' das vendas realizadas no período' +
    (d.desvioPP === null ? '.' :
      d.desvioPP > 0 ? ', acima da meta de ' + fPctTxt(d.metaPct) + '.' :
      d.desvioPP < 0 ? ', abaixo da meta de ' + fPctTxt(d.metaPct) + '.' :
      ', exatamente na meta de ' + fPctTxt(d.metaPct) + '.'));

  if (d.varAnteriorPP !== null && d.varAnteriorPP !== undefined && d.mesAnteriorNome) {
    partes.push('Em comparação com ' + d.mesAnteriorNome.toLowerCase() + ', o CMC apresentou ' +
      (d.varAnteriorPP > 0 ? 'aumento de ' + fPPTxt(d.varAnteriorPP).replace('+','') :
       d.varAnteriorPP < 0 ? 'redução de ' + fPPTxt(-d.varAnteriorPP).replace('+','') : 'estabilidade') + '.');
  }

  if (d.varComprasPct !== null && d.varComprasPct !== undefined && d.varVendasPct !== null && d.varVendasPct !== undefined) {
    partes.push('As compras cresceram ' + fPctTxt(d.varComprasPct) + ', enquanto as vendas cresceram apenas ' + fPctTxt(d.varVendasPct) +
      (d.pressao && d.pressao.nivel && d.pressao.nivel !== 'NORMAL'
        ? '. Esse comportamento indica que o ritmo de compras está superior ao crescimento das vendas.'
        : '.'));
  }

  if (d.projecaoPct !== null && d.projecaoPct !== undefined) {
    partes.push('Mantido o comportamento atual, o CMC projetado para o fechamento do mês é de ' + fPctTxt(d.projecaoPct) + '.');
  }

  if (d.status === 'CRITICO' || d.status === 'ATENCAO') {
    partes.push('Ponto de atenção: controlar o ritmo de compras e verificar se o aumento está relacionado a formação de estoque, aumento de preços, compras antecipadas ou excesso de aquisição.');
  }

  return partes.join(' ');
}
