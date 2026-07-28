// ============================================================
//  DadosCarga.gs — Carga principal multi-mês a partir do Drive
//  (depende de Constantes.gs, Utilitarios.gs, CacheProcessamento.gs, Lancamentos.gs)
// ============================================================

// ─── TESTE DE CONEXÃO (diagnóstico rápido) ────────────────────────────────────
function testeConexao() {
  try {
    const pasta = DriveApp.getFolderById(ID_PASTA_RAIZ);
    return {
      ok: true,
      nomePasta: pasta.getName(),
      timestamp: new Date().toISOString()
    };
  } catch(e) {
    return { ok: false, erro: e.message };
  }
}

// ─── FUNÇÃO PRINCIPAL: carrega TODOS os meses de uma vez ─────────────────────
function obterTodosOsDados(forcarReprocessamento) {
  const resultado = {};

  try {
    const pastaRaiz = DriveApp.getFolderById(ID_PASTA_RAIZ);
    Logger.log('[Todos] Pasta raiz: "' + pastaRaiz.getName() + '"');

    const subpastas = pastaRaiz.getFolders();
    const listaPastas = [];
    while (subpastas.hasNext()) {
      const p = subpastas.next();
      listaPastas.push({ id: p.getId(), nome: p.getName() });
      Logger.log('[Todos] Subpasta: "' + p.getName() + '"');
    }

    if (listaPastas.length === 0) {
      Logger.log('[Todos] ⚠️ Nenhuma subpasta encontrada.');
      return resultado;
    }

    listaPastas.sort((a, b) => {
      const pa = _parseMesAno(a.nome), pb = _parseMesAno(b.nome);
      if (!pa || !pb) return 0;
      return (pb.ano * 12 + pb.mes) - (pa.ano * 12 + pa.mes);
    });

    for (const pasta of listaPastas) {
      const label = _labelMes(pasta.nome);
      Logger.log('[Todos] Processando "' + label + '" (ID: ' + pasta.id + ')');

      try {
        let pacote = null;
        if (!forcarReprocessamento) pacote = _lerCache(pasta.id);

        if (!pacote) {
          Logger.log('[Todos] Cache MISS — lendo arquivos...');
          pacote = _processarArquivosDoPasta(pasta.id);
          _gravarCache(pasta.id, pacote);
        } else {
          Logger.log('[Todos] Cache HIT');
        }

        pacote.lancamentosManuais = carregarLancamentosPlanilha(label);
        pacote.nomePasta = pasta.nome;

        resultado[label] = pacote;
        Logger.log('[Todos] "' + label + '" OK');
      } catch(e) {
        Logger.log('[Todos] ERRO em "' + label + '": ' + e.message);
        resultado[label] = { erro: e.message, nomePasta: pasta.nome };
      }
    }

    Logger.log('[Todos] Concluído. Meses carregados: ' + Object.keys(resultado).join(', '));
    return resultado;

  } catch(e) {
    Logger.log('[Todos] ERRO FATAL: ' + e.message);
    throw new Error('Erro ao carregar dados: ' + e.message);
  }
}

// ─── DIAGNÓSTICO DE PASTA ─────────────────────────────────────────────────────
function diagnosticarPasta() {
  Logger.log('════ DIAGNÓSTICO ════');
  Logger.log('ID_PASTA_RAIZ: ' + ID_PASTA_RAIZ);
  try {
    const pastaRaiz = DriveApp.getFolderById(ID_PASTA_RAIZ);
    Logger.log('Pasta raiz: "' + pastaRaiz.getName() + '"');

    const subpastas = pastaRaiz.getFolders();
    let n = 0;
    while (subpastas.hasNext()) {
      const p = subpastas.next();
      Logger.log('  📁 "' + p.getName() + '" | ID: ' + p.getId() + ' | label: "' + _labelMes(p.getName()) + '"');
      n++;
    }
    Logger.log('Total subpastas: ' + n);

    const arquivos = pastaRaiz.getFiles();
    let a = 0;
    while (arquivos.hasNext()) {
      const f = arquivos.next();
      Logger.log('  📄 "' + f.getName() + '" | MIME: ' + f.getMimeType());
      a++;
    }
    Logger.log('Total arquivos na raiz: ' + a);
  } catch(e) { Logger.log('ERRO: ' + e.message); }
}