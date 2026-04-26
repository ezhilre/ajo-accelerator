/**
 * Header block — Adobe-style red banner with "Adobe | AJO Services"
 * Does NOT depend on a /nav fragment.
 */
export default function decorate(block) {
  block.textContent = '';

  const navWrapper = document.createElement('div');
  navWrapper.className = 'nav-wrapper';

  const nav = document.createElement('nav');
  nav.id = 'nav';
  nav.setAttribute('aria-label', 'Main navigation');

  const brand = document.createElement('div');
  brand.className = 'nav-brand';
  brand.innerHTML = ''
    + '<span class="nav-brand-logo">Adobe</span>'
    + '<span class="nav-brand-divider"></span>'
    + '<span class="nav-brand-name">AJO Services</span>';

  nav.appendChild(brand);
  navWrapper.appendChild(nav);
  block.appendChild(navWrapper);
}
