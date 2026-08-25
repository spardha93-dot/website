// Mobile nav toggle
const navToggle = document.querySelector(".nav-toggle");
const mainNav = document.querySelector(".main-nav");

if (navToggle && mainNav) {
  navToggle.addEventListener("click", () => {
    const isOpen = mainNav.classList.toggle("is-open");
    navToggle.setAttribute("aria-expanded", String(isOpen));
  });

  mainNav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      mainNav.classList.remove("is-open");
      navToggle.setAttribute("aria-expanded", "false");
    });
  });
}

// Project filters (Projects page)
const filterButtons = document.querySelectorAll(".filter-btn");
const filterableCards = document.querySelectorAll("[data-category]");

if (filterButtons.length && filterableCards.length) {
  filterButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      filterButtons.forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");

      const category = btn.dataset.filter;

      filterableCards.forEach((card) => {
        const matches = category === "all" || card.dataset.category === category;
        card.style.display = matches ? "" : "none";
      });
    });
  });
}

// Contact form validation + submission
const contactForm = document.querySelector("#contact-form");

if (contactForm) {
  const statusBox = contactForm.querySelector(".form-status");

  const validators = {
    name: (v) => v.trim().length > 1 || "Please enter your name.",
    email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || "Please enter a valid email address.",
    message: (v) => v.trim().length > 9 || "Please share a few more details.",
  };

  function setFieldState(field, result) {
    const wrapper = field.closest(".field");
    const errorEl = wrapper.querySelector(".error");
    if (result === true) {
      wrapper.classList.remove("has-error");
    } else {
      wrapper.classList.add("has-error");
      if (errorEl) errorEl.textContent = result;
    }
  }

  function validateField(field) {
    const rule = validators[field.name];
    if (!rule) return true;
    const result = rule(field.value);
    setFieldState(field, result);
    return result === true;
  }

  Object.keys(validators).forEach((name) => {
    const field = contactForm.querySelector(`[name="${name}"]`);
    if (field) {
      field.addEventListener("blur", () => validateField(field));
    }
  });

  contactForm.addEventListener("submit", (event) => {
    event.preventDefault();

    let isValid = true;
    Object.keys(validators).forEach((name) => {
      const field = contactForm.querySelector(`[name="${name}"]`);
      if (field && !validateField(field)) isValid = false;
    });

    statusBox.classList.remove("success", "error", "is-visible");

    if (!isValid) {
      statusBox.textContent = "Please fix the highlighted fields and try again.";
      statusBox.classList.add("error", "is-visible");
      return;
    }

    // No backend is wired up yet — this simulates a send so the form is
    // fully testable client-side. Swap this block for a real fetch() call
    // once a form endpoint (e.g. Formspree, Netlify Forms, or a custom API)
    // is connected.
    const submitBtn = contactForm.querySelector("button[type='submit']");
    submitBtn.disabled = true;
    submitBtn.textContent = "Sending…";

    setTimeout(() => {
      statusBox.textContent = "Thanks — your message has been sent. I'll reply within a couple of days.";
      statusBox.classList.add("success", "is-visible");
      contactForm.reset();
      submitBtn.disabled = false;
      submitBtn.textContent = "Send message";
    }, 700);
  });
}
