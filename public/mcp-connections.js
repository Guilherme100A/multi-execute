const sessionData = {
  a: ['Terminal A → worker conta1-a7f2 → socket #1 → Roblox A', 'A resposta volta pelo socket #1 e aparece somente no Terminal A.'],
  b: ['Terminal B → worker conta2-c91e → socket #2 → Roblox B', 'A resposta volta pelo socket #2 e aparece somente no Terminal B.'],
  c: ['Terminal C → worker alt5-42bd → socket #3 → Roblox C', 'A resposta volta pelo socket #3 e aparece somente no Terminal C.'],
};

const buttons = document.querySelectorAll('.session-button');
const activeRoute = document.querySelector('#activeRoute');
const activeReturn = document.querySelector('#activeReturn');

function selectSession(session) {
  buttons.forEach(button => {
    const active = button.dataset.session === session;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('.route-a,.route-b,.route-c').forEach(element => {
    element.classList.toggle('active', element.classList.contains(`route-${session}`));
  });
  [activeRoute.textContent, activeReturn.textContent] = sessionData[session];
}

buttons.forEach(button => button.addEventListener('click', () => selectSession(button.dataset.session)));

const replay = document.querySelector('#replay');
const stages = [...document.querySelectorAll('[data-stage]')];
let replayToken = 0;

replay.addEventListener('click', async () => {
  const token = ++replayToken;
  replay.disabled = true;
  stages.forEach(stage => stage.classList.remove('playing'));
  for (const stage of stages) {
    if (token !== replayToken) return;
    stage.classList.add('playing');
    await new Promise(resolve => setTimeout(resolve, 550));
    stage.classList.remove('playing');
  }
  replay.disabled = false;
});
