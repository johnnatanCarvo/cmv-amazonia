// ============================================================
//  Dashboard CMV · Delalê  —  Code.gs (v4 — projeto modularizado)
//  Ponto de entrada do Web App. Toda a lógica foi separada em:
//    - Constantes.gs
//    - Utilitarios.gs
//    - DadosCarga.gs
//    - Lancamentos.gs
//    - CacheProcessamento.gs
//  E o front-end em:
//    - Index.html       (estrutura)
//    - Styles.html       (CSS)
//    - Script_Core.html      (estado, init, carga drive, lançamentos, cálculo CMV)
//    - Script_Graficos.html  (KPIs, tabelas, gráficos, perdas, teórico, comparativo, árvore)
//    - Script_ABC.html       (curvas ABC, tooltip de preço, navegação/UI)
// ============================================================

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Dashboard CMV · Delalê')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
}

// Usado pelo Index.html para injetar os outros arquivos .html
// Sintaxe no HTML: <?!= include('Styles'); ?>
function include(nomeArquivo) {
  return HtmlService.createHtmlOutputFromFile(nomeArquivo).getContent();
}