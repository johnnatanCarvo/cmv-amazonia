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
        transf[mesNome].filiais[filDestino] = { total:0, entrada:0, saida:0, origens:{}, produtos:[] };
      }
      var tfD = transf[mesNome].filiais[filDestino];
      tfD.total   += total;
      tfD.entrada += total;
      tfD.origens[fornecedor] = (tfD.origens[fornecedor] || 0) + total;
      tfD.produtos.push({ nome:prod, grupo:grupo, origem:fornecedor, destino:filDestino, qtd:r2(qtd), valor:r2(total), data:limpaCelula(r[C_COMPRAS.data]) });

      // Registro de SAÍDA na filial de origem
      if (!transf[mesNome].filiais[filOrig]) {
        transf[mesNome].filiais[filOrig] = { total:0, entrada:0, saida:0, origens:{}, produtos:[] };
      }
      transf[mesNome].filiais[filOrig].saida += total;
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
      var entrada = tf.entrada || 0;
      var saida   = tf.saida   || 0;

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
        total:   r2(tf.total),
        entrada: r2(entrada),
        saida:   r2(saida),
        saldo:   r2(entrada - saida),
        origens: origens,
        produtos: produtosConsolidados
      };
      // anexar dentro da filial do CMC: entrada, saida e saldo de transferencia
      if (cmc[mes].filiais && cmc[mes].filiais[fil]) {
        cmc[mes].filiais[fil].transf_entrada = r2(entrada);
        cmc[mes].filiais[fil].transf_saida   = r2(saida);
        cmc[mes].filiais[fil].transf_saldo   = r2(entrada - saida);
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
