const toggle = document.getElementById('nav-toggle');
const links = document.getElementById('nav-links');

if (toggle && links) {
  toggle.addEventListener('click', () => links.classList.toggle('open'));

  links.addEventListener('click', (event) => {
    if (event.target.closest('a')) links.classList.remove('open');
  });
}

document.querySelectorAll('.year').forEach((node) => {
  node.textContent = String(new Date().getFullYear());
});
