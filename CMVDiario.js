// ============================================================
//  CMV DIÁRIO E POR PERÍODO (qualquer faixa de datas, dia a dia)
// ============================================================
// Pensado pro Açaí na Cuia, mas vale pro negócio ativo. Dia a dia NÃO existe estoque contado, então o
// número diário é o de FLUXO:
//   - faturamento e CMV Teórico (vendas do dia x ficha x custo do litro/insumo do mês);
//   - compras externas do dia (CMC) e CMC% sobre o faturamento;
//   - Açaí: latas consumidas e litros produzidos (produção do Cloudfy) e o rendimento (L por lata).
// O CMV REAL (estoque inicial + compras - estoque final) só existe pro PERÍODO e só quando há contagem
// perto das duas pontas: vem de calcularCMVPersonalizadoTodas_ (contagem real mais próxima, até 10 dias).
var CMV_DIARIO_MAX_DIAS = 93;

function calcularCMVDiario(senha, iniISO, fimISO, negocio) {
  definirNegocio_(negocio);   // escopo desta execução; ver NEGOCIOS
  if (!validarSenha(senha)) return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  try {
    var r = cmvDiario_(iniISO, fimISO);
    r.ok = true;
    return JSON.stringify(r);
  } catch (err) {
    Logger.log('calcularCMVDiario ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

function cmvDiarioISO_(info) { return info.ano + '-' + pad2(info.mes) + '-' + pad2(info.dia); }
function cmvDiarioBR_(info) { return pad2(info.dia) + '/' + pad2(info.mes) + '/' + info.ano; }

function cmvDiario_(iniISO, fimISO) {
  var ini = parseISOData_(iniISO), fim = parseISOData_(fimISO);
  if (!ini || !fim) throw new Error('Informe as duas datas do período.');
  var tsIni = new Date(ini.ano, ini.mes - 1, ini.dia).getTime(), tsFim = new Date(fim.ano, fim.mes - 1, fim.dia).getTime();
  if (tsFim < tsIni) throw new Error('A data final é anterior à inicial.');
  var nDias = Math.round((tsFim - tsIni) / 86400000) + 1;
  if (nDias > CMV_DIARIO_MAX_DIAS) throw new Error('O período pode ter no máximo ' + CMV_DIARIO_MAX_DIAS + ' dias.');

  var unidades = filiaisDoNegocioAtivo_();
  var ehUnidade = {}; unidades.forEach(function(u) { ehUnidade[u.toUpperCase()] = true; });
  var iniKey = ini.ano + pad2(ini.mes) + pad2(ini.dia), fimKey = fim.ano + pad2(fim.mes) + pad2(fim.dia);

  var rowsVendas  = lerVendasCompleto_();
  var rowsCompras = lerComprasCompleto_();
  var rowsFichas  = lerFichaTecnica();
  var fichasMap   = processarFichas(rowsFichas);
  var receitas    = processarReceitas(rowsFichas);
  var historico   = preAgregarCustoMedioPorInsumo(rowsCompras);
  var fichaPorCodigo = preAgregarFichaPorCodigo(rowsFichas);

  // ponte produto vendido -> produto da ficha (mesma ordem de calcularCMVTeorico: nome, código, nome normalizado)
  var fichaPorNomeNorm = indiceNomesNormalizados_(fichasMap);
  function resolverNomeFicha(nome, cod) {
    if (fichasMap[nome] !== undefined) return nome;
    if (cod && fichaPorCodigo[cod] && fichasMap[fichaPorCodigo[cod].nome] !== undefined) return fichaPorCodigo[cod].nome;
    var alvo = fichaPorNomeNorm[normalizarNomeProduto_(nome)];
    return (alvo !== undefined) ? alvo : nome;
  }
  var memoCusto = {};
  function custoUnitario(nomeFicha, mes, ano) {
    var k = nomeFicha + '|' + mes + '|' + ano;
    if (memoCusto[k] !== undefined) return memoCusto[k];
    var c = null;
    if (receitas[nomeFicha]) c = calcularCustoExplodido(receitas, nomeFicha, 1, NOMES_MESES[mes], ano, historico, []);
    if (c === null || c === undefined) c = fichasMap[nomeFicha];
    memoCusto[k] = (c === undefined) ? null : c;
    return memoCusto[k];
  }

  // um balde por dia (todos os dias do período, mesmo sem movimento) e por unidade
  var dias = {}, ordem = [];
  function vazio() { return { fat: 0, compras: 0, transf: 0, cmvTeorico: 0, semFicha: 0 }; }
  for (var t = tsIni; t <= tsFim; t += 86400000) {
    var d = new Date(t + 12 * 3600000);          // meio-dia: evita virada por horário de verão
    var info = { ano: d.getFullYear(), mes: d.getMonth() + 1, dia: d.getDate() };
    var b = { iso: cmvDiarioISO_(info), data: cmvDiarioBR_(info), mes: info.mes, ano: info.ano, porUnidade: {}, producao: null };
    unidades.forEach(function(u) { b.porUnidade[u] = vazio(); });
    dias[b.iso] = b; ordem.push(b.iso);
  }

  // ── vendas: faturamento e CMV Teórico ──
  var produtosPeriodo = {};
  for (var i = 1; i < rowsVendas.length; i++) {
    var r = rowsVendas[i];
    if (!r || r.length < 15) continue;
    var filial = limpaCelula(r[C_VENDAS.filial]).toUpperCase();
    if (!ehUnidade[filial]) continue;
    var di = parseDataCompleta(r[C_VENDAS.data]);
    if (!di) continue;
    var key = di.ano + pad2(di.mes) + pad2(di.dia);
    if (key < iniKey || key > fimKey) continue;
    var produto = limpaCelula(r[C_VENDAS.produto]);
    if (!produto || naoEhVenda_(produto)) continue;
    if (GRUPOS_EXCLUIR_ABC.indexOf(limpaCelula(r[C_VENDAS.grupo]).toUpperCase()) >= 0) continue;
    var bUni = dias[di.ano + '-' + pad2(di.mes) + '-' + pad2(di.dia)].porUnidade[unidadeOriginal_(unidades, filial)];
    var valor = numVal(r[C_VENDAS.valor]), qtd = numVal(r[C_VENDAS.qtd]), cod = limpaCelula(r[C_VENDAS.cod]);
    bUni.fat += valor;
    var nomeFicha = resolverNomeFicha(produto, cod);
    var temFicha = fichasMap[nomeFicha] !== undefined;
    var custoUn = temFicha ? custoUnitario(nomeFicha, di.mes, di.ano) : null;
    if (qtd > 0 && custoUn !== null) bUni.cmvTeorico += custoUn * qtd;
    else if (!temFicha || custoUn === null) bUni.semFicha += valor;
    var pk = cod || produto;
    var p = produtosPeriodo[pk] = produtosPeriodo[pk] || { produto: produto, qtd: 0, valor: 0, custo: 0, temFicha: temFicha };
    if (valor > (p.maiorValor || 0)) { p.maiorValor = valor; p.produto = (fichaPorCodigo[cod] && fichaPorCodigo[cod].nome) || produto; }
    p.qtd += qtd; p.valor += valor; if (qtd > 0 && custoUn !== null) p.custo += custoUn * qtd;
  }

  // ── compras externas (CMC): transferência entre unidades fica de fora, como no resto do painel ──
  for (var j = 1; j < rowsCompras.length; j++) {
    var rc = rowsCompras[j];
    if (!rc || rc.length < 18) continue;
    var filC = limpaCelula(rc[C_COMPRAS.filial]).toUpperCase();
    if (!ehUnidade[filC]) continue;
    var dc = parseDataCompleta(rc[C_COMPRAS.data]);
    if (!dc) continue;
    var keyC = dc.ano + pad2(dc.mes) + pad2(dc.dia);
    if (keyC < iniKey || keyC > fimKey) continue;
    var total = numVal(rc[C_COMPRAS.total]);
    var forn = limpaCelula(rc[C_COMPRAS_FORNECEDOR]).toUpperCase();
    var bC = dias[dc.ano + '-' + pad2(dc.mes) + '-' + pad2(dc.dia)].porUnidade[unidadeOriginal_(unidades, filC)];
    if (forn.indexOf(TRANSFERENCIA_MARCADOR) >= 0) bC.transf += total; else bC.compras += total;
  }

  // ── Açaí na Cuia: produção do Cloudfy (latas consumidas, litros produzidos) ──
  var mostraProducao = (NEGOCIO_ATIVO === 'ACAI NA CUIA');
  var custoLataMes = {};
  var custoProducaoMeses = [];
  if (mostraProducao) {
    var cache = cfyLerCacheProducaoAcai_() || [];
    var resumoMes = cfyCustoProducaoAcai_(historico);
    resumoMes.forEach(function(m) {
      custoLataMes[m.ano + '|' + m.mes] = m;
      // só os meses que o período toca
      var chave = m.ano * 100 + m.mes;
      if (chave >= ini.ano * 100 + ini.mes && chave <= fim.ano * 100 + fim.mes) custoProducaoMeses.push(m);
    });
    cache.forEach(function(l) {
      var bd = dias[l.ano + '-' + pad2(l.mes) + '-' + pad2(l.dia)];
      if (!bd) return;
      var pr = bd.producao = bd.producao || { latas: 0, litrosMedio: 0, litrosGrosso: 0 };
      if (l.cod === ACAI_COD_LATA) pr.latas += l.sai;
      else if (l.cod === ACAI_COD_MEDIO) pr.litrosMedio += l.ent;
      else if (l.cod === ACAI_COD_GROSSO) pr.litrosGrosso += l.ent;
    });
  }

  // ── fecha cada dia e o período ──
  function fechar(o) {
    return { fat: r2(o.fat), compras: r2(o.compras), transf: r2(o.transf), cmvTeorico: r2(o.cmvTeorico), semFicha: r2(o.semFicha),
             cmc_pct: calcularPct(o.compras, o.fat), cmv_teorico_pct: calcularPct(o.cmvTeorico, o.fat) };
  }
  var totalPorUnidade = {}; unidades.forEach(function(u) { totalPorUnidade[u] = vazio(); });
  var producaoTotal = { latas: 0, litrosMedio: 0, litrosGrosso: 0 };
  var listaDias = ordem.map(function(iso) {
    var bd = dias[iso];
    var todas = vazio();
    var porUni = {};
    unidades.forEach(function(u) {
      var o = bd.porUnidade[u];
      ['fat', 'compras', 'transf', 'cmvTeorico', 'semFicha'].forEach(function(k) { todas[k] += o[k]; totalPorUnidade[u][k] += o[k]; });
      porUni[u] = fechar(o);
    });
    var linha = { iso: iso, data: bd.data, todas: fechar(todas), porUnidade: porUni, producao: null };
    if (bd.producao) {
      var pr = bd.producao, litros = pr.litrosMedio + pr.litrosGrosso;
      var m = custoLataMes[bd.ano + '|' + bd.mes];
      var custoLata = m ? m.custoLata : null;
      linha.producao = { latas: r2(pr.latas), litros: r2(litros), litrosMedio: r2(pr.litrosMedio), litrosGrosso: r2(pr.litrosGrosso),
        rendimento: (pr.latas > 0 && litros > 0) ? r4(litros / pr.latas) : null,
        custoLitroDia: (pr.latas > 0 && litros > 0 && custoLata !== null && custoLata !== undefined) ? r4(pr.latas * custoLata / litros) : null };
      producaoTotal.latas += pr.latas; producaoTotal.litrosMedio += pr.litrosMedio; producaoTotal.litrosGrosso += pr.litrosGrosso;
    }
    return linha;
  });
  var totalTodas = vazio();
  unidades.forEach(function(u) { ['fat', 'compras', 'transf', 'cmvTeorico', 'semFicha'].forEach(function(k) { totalTodas[k] += totalPorUnidade[u][k]; }); });
  var totalUni = {}; unidades.forEach(function(u) { totalUni[u] = fechar(totalPorUnidade[u]); });
  var litrosTot = producaoTotal.litrosMedio + producaoTotal.litrosGrosso;

  var produtos = Object.keys(produtosPeriodo).map(function(k) { var p = produtosPeriodo[k];
    return { produto: p.produto, qtd: r2(p.qtd), valor: r2(p.valor), custo_teorico: r2(p.custo), tem_ficha: p.temFicha };
  }).sort(function(a, b) { return b.valor - a.valor; });

  // ── CMV REAL do período, quando há contagem perto das duas pontas ──
  var real = null;
  if (nDias >= 2) {
    try {
      var rr = calcularCMVPersonalizadoTodas_(cmvDiarioBR_(ini), cmvDiarioBR_(fim));
      var porUniReal = {};
      Object.keys(rr.porUnidade || {}).forEach(function(u) {
        var x = rr.porUnidade[u];
        porUniReal[u] = { disponivel: !!x.disponivel, ei: x.ei, ef: x.ef, compras: x.compras, cmv: x.cmv, cmv_pct: x.cmv_pct,
                          eiData: x.eiData, efData: x.efData, eiDesvioDias: x.eiDesvioDias, efDesvioDias: x.efDesvioDias };
      });
      real = { disponivel: !!rr.disponivel, ei: rr.ei, ef: rr.ef, compras: rr.compras, cmv: rr.cmv, cmv_pct: rr.cmv_pct, porUnidade: porUniReal };
    } catch (eReal) {
      real = { disponivel: false, erro: eReal.message };
    }
  } else {
    real = { disponivel: false, erro: 'O CMV real precisa de um período de pelo menos 2 dias.' };
  }

  return {
    negocio: NEGOCIO_ATIVO, unidades: unidades, dataInicio: cmvDiarioBR_(ini), dataFim: cmvDiarioBR_(fim), nDias: nDias,
    mostraProducao: mostraProducao,
    dias: listaDias,
    total: { todas: fechar(totalTodas), porUnidade: totalUni },
    producao: mostraProducao ? { latas: r2(producaoTotal.latas), litros: r2(litrosTot), litrosMedio: r2(producaoTotal.litrosMedio), litrosGrosso: r2(producaoTotal.litrosGrosso),
      rendimento: (producaoTotal.latas > 0 && litrosTot > 0) ? r4(litrosTot / producaoTotal.latas) : null } : null,
    produtos: produtos.slice(0, 40),
    custoProducao: custoProducaoMeses,
    real: real
  };
}

// o nome da unidade como está no negócio (a planilha traz caixa/espaço diferente)
function unidadeOriginal_(unidades, filialMaiuscula) {
  for (var i = 0; i < unidades.length; i++) if (unidades[i].toUpperCase() === filialMaiuscula) return unidades[i];
  return filialMaiuscula;
}
