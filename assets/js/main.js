// ============================================
// Warren Mak - Main JavaScript
// ============================================

// Mobile Navigation Toggle
document.addEventListener('DOMContentLoaded', function() {
  const navToggle = document.getElementById('navToggle');
  const navMenu = document.getElementById('navMenu');

  if (navToggle && navMenu) {
    navToggle.addEventListener('click', function() {
      var isOpen = navMenu.classList.toggle('active');
      navToggle.innerHTML = isOpen ? '&#10005;' : '&#9776;';
      navToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      document.body.classList.toggle('nav-open', isOpen);
      if (!isOpen) {
        closeAllDropdowns();
      }
    });

    // Close menu when clicking a link
    navMenu.querySelectorAll('a').forEach(function(link) {
      link.addEventListener('click', function() {
        navMenu.classList.remove('active');
        navToggle.innerHTML = '&#9776;';
        navToggle.setAttribute('aria-expanded', 'false');
        document.body.classList.remove('nav-open');
        closeAllDropdowns();
      });
    });
  }

  // ============================================
  // Nav Dropdowns (About / Courses / Learn)
  // ============================================
  var dropdowns = document.querySelectorAll('.navbar__dropdown');

  dropdowns.forEach(function(dropdown) {
    var trigger = dropdown.querySelector('.navbar__dropdown-trigger');
    if (!trigger) return;

    trigger.addEventListener('click', function(e) {
      e.stopPropagation();
      var isOpen = dropdown.classList.contains('open');
      closeAllDropdowns();
      if (!isOpen) {
        dropdown.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');
      }
    });
  });

  // Close dropdowns when clicking outside
  document.addEventListener('click', function(e) {
    if (!e.target.closest('.navbar__dropdown')) {
      closeAllDropdowns();
    }
  });

  // Close dropdowns on Escape
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      closeAllDropdowns();
    }
  });

  // Scroll Animation Observer
  var animatedElements = document.querySelectorAll('[data-animate]');
  if (animatedElements.length > 0 && 'IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, {
      threshold: 0.1,
      rootMargin: '0px 0px -50px 0px'
    });

    animatedElements.forEach(function(el) {
      observer.observe(el);
    });
  }

  // Navbar background on scroll
  var navbar = document.querySelector('.navbar');
  if (navbar) {
    window.addEventListener('scroll', function() {
      if (window.scrollY > 50) {
        navbar.style.background = 'rgba(26, 35, 50, 0.98)';
        navbar.style.boxShadow = '0 2px 20px rgba(0,0,0,0.15)';
      } else {
        navbar.style.background = 'rgba(26, 35, 50, 0.95)';
        navbar.style.boxShadow = 'none';
      }
    });
  }

  // ============================================
  // Language Toggle (EN / 中文)
  // ============================================
  initLanguageToggle();
});

function closeAllDropdowns() {
  document.querySelectorAll('.navbar__dropdown.open').forEach(function(dropdown) {
    dropdown.classList.remove('open');
    var trigger = dropdown.querySelector('.navbar__dropdown-trigger');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  });
}

function initLanguageToggle() {
  // Get saved language or default to 'en'
  var currentLang = localStorage.getItem('wm_lang') || 'en';
  applyLanguage(currentLang);

  // Bind toggle button
  var toggleBtn = document.getElementById('langToggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', function() {
      var newLang = currentLang === 'en' ? 'zh' : 'en';
      currentLang = newLang;
      localStorage.setItem('wm_lang', newLang);
      applyLanguage(newLang);
    });
  }
}

function applyLanguage(lang) {
  // Update toggle button text
  var toggleBtn = document.getElementById('langToggle');
  if (toggleBtn) {
    toggleBtn.textContent = lang === 'en' ? '中文' : 'EN';
    toggleBtn.setAttribute('title', lang === 'en' ? 'Switch to Chinese' : 'Switch to English');
  }

  // Show/hide elements by lang attribute
  var enElements = document.querySelectorAll('[data-lang="en"]');
  var zhElements = document.querySelectorAll('[data-lang="zh"]');

  enElements.forEach(function(el) {
    el.style.display = lang === 'en' ? '' : 'none';
  });

  zhElements.forEach(function(el) {
    el.style.display = lang === 'zh' ? '' : 'none';
  });

  // Update html lang attribute
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-Hans';

  // Reveal body if it was hidden by the anti-flash snippet in <head>
  // (see wm-lang-hide / data-lang-pending — only present for zh-preference visitors)
  if (document.documentElement.hasAttribute('data-lang-pending')) {
    document.documentElement.removeAttribute('data-lang-pending');
    var hideStyle = document.getElementById('wm-lang-hide');
    if (hideStyle) hideStyle.remove();
  }
}
