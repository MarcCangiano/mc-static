/**
 * The only JavaScript in the theme, and it does one thing: show the
 * back-to-top control once there is somewhere to go back to.
 *
 * The contact menu is a <details> element and needs no script at all, so it
 * still works if this file fails to load. That matters more than it sounds:
 * a broken script should not be able to take the phone number with it.
 */
( function () {
	var btn = document.getElementById( 'mc-top' );
	if ( ! btn ) {
		return;
	}

	var shown = false;
	function update() {
		var should = window.scrollY > 600;
		if ( should !== shown ) {
			shown = should;
			btn.classList.toggle( 'is-on', should );
		}
	}

	// passive: this listener must never delay a scroll.
	window.addEventListener( 'scroll', update, { passive: true } );
	update();

	btn.addEventListener( 'click', function ( event ) {
		event.preventDefault();
		var reduce = window.matchMedia( '(prefers-reduced-motion: reduce)' ).matches;
		window.scrollTo( { top: 0, behavior: reduce ? 'auto' : 'smooth' } );
		// Move focus to the top so keyboard users go where the page went.
		var first = document.querySelector( 'header a, header h1, main' );
		if ( first ) {
			first.setAttribute( 'tabindex', '-1' );
			first.focus( { preventScroll: true } );
		}
	} );

	// Close the off-canvas menu on Escape and after choosing a section.
	// The panel itself opens without any of this.
	var menu = document.getElementById( 'mc-menu' );
	if ( menu ) {
		document.querySelectorAll( '.mc-nav a' ).forEach( function ( link ) {
			link.addEventListener( 'click', function () { menu.checked = false; } );
		} );
		document.addEventListener( 'keydown', function ( e ) {
			if ( e.key === 'Escape' && menu.checked ) { menu.checked = false; }
		} );
	}

	// A details menu that stays open after you have left it is a nuisance.
	var contact = document.querySelector( '.mc-contact' );
	if ( ! contact ) {
		return;
	}

	var summary = contact.querySelector( 'summary' );
	var panel = contact.querySelector( '.mc-links' );

	// Closing has to be deferred, or the panel is removed from the page before
	// the exit animation can play. Opening needs no help: the keyframe runs as
	// soon as the element exists.
	function close() {
		if ( ! contact.open || contact.classList.contains( 'is-closing' ) ) {
			return;
		}
		var reduce = window.matchMedia( '(prefers-reduced-motion: reduce)' ).matches;
		if ( reduce || ! panel ) {
			contact.open = false;
			return;
		}
		contact.classList.add( 'is-closing' );
		var done = function () {
			contact.classList.remove( 'is-closing' );
			contact.open = false;
			panel.removeEventListener( 'animationend', done );
		};
		panel.addEventListener( 'animationend', done );
		// If the animation never fires, the menu must still close.
		setTimeout( done, 260 );
	}

	if ( summary ) {
		summary.addEventListener( 'click', function ( e ) {
			if ( contact.open ) {
				e.preventDefault();
				close();
			}
		} );
	}

	document.addEventListener( 'click', function ( e ) {
		if ( contact.open && ! contact.contains( e.target ) ) {
			close();
		}
	} );
	document.addEventListener( 'keydown', function ( e ) {
		if ( e.key === 'Escape' && contact.open ) {
			close();
		}
	} );
}() );


/* Clear #sent from the address bar once the notice has shown, so a refresh
   does not replay it. Progressive enhancement only: with JS off the CSS
   animation still hides the notice, the fragment simply persists. */
(function(){
	if(location.hash!=='#sent')return;
	var reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	setTimeout(function(){
		try{history.replaceState(null,'',location.pathname+location.search);}catch(e){}
	},reduce?3000:3600);
}());

(function () {
  var box = document.querySelector('[data-mc-check]');
  if (!box) return;
  var input = box.querySelector('input[type="checkbox"]');
  var elapsed = document.querySelector('input[name="_elapsed"]');
  var started = Date.now();

  input.addEventListener('click', function (e) {
    // Confirmed is a one-way door.
    if (input.dataset.locked === '1') { e.preventDefault(); return; }
  });

  input.addEventListener('change', function () {
    if (!input.checked) return;
    input.dataset.locked = '1';
    box.classList.add('is-done');
    /* Not aria-disabled: the value is still submitted, so calling it disabled
       would be a lie to assistive tech and would stop it being focusable.
       aria-readonly says what is actually true — it can be read, not changed. */
    input.setAttribute('aria-readonly', 'true');
  });

  var form = box.closest('form');
  if (form) {
    form.addEventListener('submit', function () {
      if (elapsed) elapsed.value = String(Math.round((Date.now() - started) / 1000));
    });
  }
}());
