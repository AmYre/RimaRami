import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculerPartie,
  calculerClassement,
  proposerTables,
  taillesTables,
  REGLAGES_PAR_DEFAUT,
} from '../public/js/rules.js';

const B1 = REGLAGES_PAR_DEFAUT.bareme[1];
const B2 = REGLAGES_PAR_DEFAUT.bareme[2];
const m = (scores) => ({ scores });

test('table de 4 : la partie continue après un seul sorti', () => {
  const etat = calculerPartie({
    joueurs: [1, 2, 3, 4],
    manches: [m({ 1: 300, 2: 100, 3: 50, 4: 0 }), m({ 1: 402, 2: 100, 3: 50, 4: 20 })],
    seuil: 701,
    bareme: B1,
  });
  assert.equal(etat.terminee, false);
  assert.deepEqual(etat.ordreSortie, [1]);
  assert.deepEqual(etat.enJeu, [2, 3, 4]);
  assert.equal(etat.sortisRestants, 1);
});

test('701 pile ne sort pas, 702 sort', () => {
  const etat = calculerPartie({ joueurs: [1, 2, 3], manches: [m({ 1: 701, 2: 0, 3: 0 })], seuil: 701 });
  assert.equal(etat.terminee, false);
  const etat2 = calculerPartie({ joueurs: [1, 2, 3], manches: [m({ 1: 702, 2: 0, 3: 0 })], seuil: 701 });
  assert.equal(etat2.terminee, true);
});

test('table de 4 : fin au 2e sorti, places et points', () => {
  const etat = calculerPartie({
    joueurs: [1, 2, 3, 4],
    manches: [
      m({ 1: 710, 2: 100, 3: 50, 4: 0 }), // 1 sort
      m({ 2: 300, 3: 50, 4: 20 }), // 1 ne marque plus
      m({ 2: 400, 3: 50, 4: 200 }), // 2 sort (800)
    ],
    seuil: 701,
    bareme: B1,
  });
  assert.equal(etat.terminee, true);
  const places = Object.fromEntries(etat.classement.map((c) => [c.id, c.place]));
  assert.deepEqual(places, { 3: 1, 4: 2, 2: 3, 1: 4 });
  const pts = Object.fromEntries(etat.classement.map((c) => [c.id, c.points]));
  assert.deepEqual(pts, { 3: 10, 4: 7, 2: 5, 1: 3 });
  assert.equal(etat.totaux[1], 710);
});

test('table de 3 : fin au 1er sorti', () => {
  const etat = calculerPartie({
    joueurs: [5, 6, 7],
    manches: [m({ 5: 200, 6: 300, 7: 100 }), m({ 5: 200, 6: 450, 7: 100 })],
    seuil: 701,
    bareme: B2,
  });
  assert.equal(etat.terminee, true);
  assert.deepEqual(
    etat.classement.map((c) => [c.id, c.place, c.points]),
    [
      [7, 1, 5],
      [5, 2, 3],
      [6, 3, 1],
    ],
  );
});

test('deux sortis dans la même manche : le plus gros total finit dernier', () => {
  const etat = calculerPartie({
    joueurs: [1, 2, 3, 4],
    manches: [m({ 1: 750, 2: 720, 3: 10, 4: 0 })],
    seuil: 701,
    bareme: B1,
  });
  assert.equal(etat.terminee, true);
  assert.deepEqual(
    etat.classement.map((c) => c.id),
    [4, 3, 2, 1],
  );
});

test('égalité parfaite : même place, mêmes points', () => {
  const etat = calculerPartie({
    joueurs: [1, 2, 3],
    manches: [m({ 1: 100, 2: 100, 3: 800 })],
    seuil: 701,
    bareme: B2,
  });
  assert.deepEqual(
    etat.classement.map((c) => [c.id, c.place, c.points]),
    [
      [1, 1, 5],
      [2, 1, 5],
      [3, 3, 1],
    ],
  );
});

test('manches en trop après une correction', () => {
  const etat = calculerPartie({
    joueurs: [1, 2, 3],
    manches: [m({ 1: 800, 2: 0, 3: 0 }), m({ 2: 10, 3: 10 })],
    seuil: 701,
  });
  assert.equal(etat.terminee, true);
  assert.equal(etat.manchesEnTrop, 1);
  assert.equal(etat.totaux[2], 0);
});

test('classement général : cumul, victoires, moyenne', () => {
  const p1 = calculerPartie({ joueurs: [1, 2, 3, 4], manches: [m({ 1: 0, 2: 10, 3: 800, 4: 900 })], seuil: 701, bareme: B1 });
  const p2 = calculerPartie({ joueurs: [5, 6, 7], manches: [m({ 5: 0, 6: 10, 7: 900 })], seuil: 701, bareme: B2 });
  const cl = calculerClassement(
    [
      { table: 1, etat: p1 },
      { table: 2, etat: p2 },
    ],
    [1, 2, 3, 4, 5, 6, 7],
  );
  assert.deepEqual(
    cl.map((l) => [l.id, l.points]),
    [
      [1, 10],
      [2, 7],
      [5, 5],
      [3, 5],
      [4, 3],
      [6, 3],
      [7, 1],
    ],
  );
  assert.equal(cl[0].victoires, 1);
  assert.equal(cl[0].partiesT1, 1);
  // 5 et 3 : mêmes points mais 5 a une victoire → 5 devant
  assert.equal(cl[2].rang, 3);
  assert.equal(cl[3].rang, 4);
  // 4 et 6 : mêmes points, même moyenne, 0 victoire → même rang
  assert.equal(cl[4].rang, 5);
  assert.equal(cl[5].rang, 5);
});

test('tailles des tables', () => {
  assert.deepEqual(taillesTables(7), [4, 3]);
  assert.deepEqual(taillesTables(8), [4, 4]);
  assert.deepEqual(taillesTables(6), [3, 3]);
  assert.deepEqual(taillesTables(5), [3, 2]);
  assert.deepEqual(taillesTables(4), [4]);
});

test('montée / descente : le 1er de T2 monte, le dernier de T1 descend', () => {
  const dernierTour = [
    { table: 1, classement: [{ id: 1, place: 1 }, { id: 2, place: 2 }, { id: 3, place: 3 }, { id: 4, place: 4 }] },
    { table: 2, classement: [{ id: 5, place: 1 }, { id: 6, place: 2 }, { id: 7, place: 3 }] },
  ];
  const { tables, mouvements } = proposerTables({ dernierTour, presents: [1, 2, 3, 4, 5, 6, 7] });
  assert.deepEqual(tables, [
    [1, 2, 3, 5],
    [4, 6, 7],
  ]);
  assert.equal(mouvements[5], 'monte');
  assert.equal(mouvements[4], 'descend');
  assert.equal(mouvements[1], 'reste');
});

test('montée / descente avec un absent et un nouveau', () => {
  const dernierTour = [
    { table: 1, classement: [{ id: 1, place: 1 }, { id: 2, place: 2 }, { id: 3, place: 3 }, { id: 4, place: 4 }] },
    { table: 2, classement: [{ id: 5, place: 1 }, { id: 6, place: 2 }, { id: 7, place: 3 }] },
  ];
  // 2 absent, 8 nouveau
  const { tables, mouvements } = proposerTables({ dernierTour, presents: [1, 3, 4, 5, 6, 7, 8] });
  assert.deepEqual(tables, [
    [1, 3, 5, 4],
    [6, 7, 8],
  ]);
  assert.equal(mouvements[4], 'reste');
  assert.equal(mouvements[6], 'reste');
  assert.equal(mouvements[8], 'nouveau');
});

test('premier tour : ordre des présents', () => {
  const { tables } = proposerTables({ dernierTour: null, presents: [1, 2, 3, 4, 5, 6, 7] });
  assert.deepEqual(tables, [
    [1, 2, 3, 4],
    [5, 6, 7],
  ]);
});
