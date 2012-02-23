/*global document, location, io, XMLHttpRequest, setTimeout, setInterval, clearInterval, StyleFix, less, ActiveXObject*/
(function () {
    'use strict';

    var liveStyleOptions = {}; // The options will be injected by the server

    function log() { // ...
        if (liveStyleOptions.debug && window.console) {
            console.log.apply(console, arguments);
        }
    }

    if (!Array.prototype.indexOf) {
        Array.prototype.indexOf = function (o, from) {
            var i;
            for (i = from || 0; i < this.length; i += 1) {
                if (this[i] === o) {
                    return i;
                }
            }
            return -1;
        };
    }

    var pollTimeout = 2000,
        escapeRegExp = function (str) {
            return str.replace(/[\.\+\*\{\}\[\]\(\)\?\^\$]/g, '\\$&');
        },
        cleanHref = function (href) {
            var local = new RegExp(
                '^' + escapeRegExp(document.location.protocol + '//' + document.location.host + (document.location.port ? ':' + document.location.port : '')) + '/' +
                (liveStyleOptions.proxy ? '|^' + escapeRegExp(liveStyleOptions.proxy) : ''),
                'i'),
                remote = /:\/\/|^\/\//;

            if (/^data:/.test(href)) {
                // AdBlock for Chrome injects these
                return false;
            }

            // Normalize all hrefs to be root relative
            href = '/' + href.replace(local, '').replace(/^\//, '').replace(/\?.*$/, '');

            return !remote.test(href) && href;
        },
        findCssIncludes = function () {
            var cssIncludes = [],
                links = document.getElementsByTagName('link'),
                styles = document.getElementsByTagName('style'),
                style,
                cssRule,
                i,
                href;

            // Link tags with rel="stylesheet"
            for (i = 0; i < links.length; i += 1) {
                if (/\bstylesheet\b/i.test(links[i].getAttribute('rel'))) {
                    href = cleanHref(links[i].getAttribute('href'));
                    if (href) {
                        cssIncludes.push({type: 'link', href: href, node: links[i]});
                    }
                }
            }

            // Style tags: @includes and inline prefixfree blocks
            for (i = 0 ; i < styles.length ; i += 1) {
                style = styles[i];

                if (typeof StyleFix !== 'undefined') {
                    // Prefixfree support
                    href = style.href || style.getAttribute('data-href');

                    if (href) {
                        cssIncludes.push({type: 'prefixfree', href: cleanHref(href), node: style});
                    }
                }

                // @import
                style.innerHTML.replace(/@import\s+(?:'([^']+)'|"([^"]+)"|url\(([^\)]+)\))/g, function ($0, singleQuotedHref, doubleQuotedHref, urlParenthesesHref) {
                    if (urlParenthesesHref) {
                        urlParenthesesHref = urlParenthesesHref.replace(/^(['"])(.*)\1$/, '$2');
                    }
                    var href = singleQuotedHref || doubleQuotedHref || urlParenthesesHref;
                    cssIncludes.push({type: 'import', href: href, styleElement: style});
                });
            }

            return cssIncludes;
        },
        removeCacheBuster = function (href) {
            return href.replace(/[?&]livestyle=\d+/, '');
        },
        addCacheBuster = function (href) {
            return href + (href.indexOf('?') === -1 ? '?' : '&') + 'livestyle=' + new Date().getTime();
        },

        // Replaces a link tag with an updated version. Just replacing the href would cause FOUC.
        // We insert the new node before the old one and remove the old one after the new one has loaded.
        replaceLinkTag = function (node, href) {
            var parent = node.parentNode,
                newNode = node.cloneNode(true),
                monitor;

            newNode.href = href;
            newNode.onload = function () {
                if (node.parentNode) {
                    parent.removeChild(node);

                    clearInterval(monitor);
                }
            };

            monitor = setInterval(function () {
                try {
                    if (newNode.sheet && newNode.sheet.cssRules.length > 0) { // Throws an error if the stylesheet hasn't loaded
                        newNode.onload();
                    }
                } catch (err) {}
            }, 20);

            if (node.nextSibling) {
                parent.insertBefore(newNode, node.nextSibling);
            } else {
                parent.appendChild(newNode);
            }
        },
        replaceStyleTag = function (node, oldHref, newHref) {
            var parent = node.parentNode,
                newNode = node.cloneNode(),
                replacerRegexp = new RegExp("@import\\s+url\\([\"']?" + oldHref.replace(/[\?\[\]\(\)\{\}]/g, "\\$&") + "[\"']?\\)");

            newNode.textContent = node.textContent.replace(replacerRegexp, '@import url(\'' + newHref + '\')');
            parent.insertBefore(newNode, node);
            parent.removeChild(node);
        },
        refresh = function (href) {
            var cssIncludes = findCssIncludes(),
                i,
                cssInclude,
                cssIncludeHref,
                newHref,
                replacerRegExp;

            if (href === location.pathname) {
                location.reload(true);
            }

            for (i = 0; i < cssIncludes.length; i += 1) {
                cssInclude = cssIncludes[i];
                cssIncludeHref = removeCacheBuster(cssInclude.href);

                if (cssIncludeHref === href) {
                    newHref = addCacheBuster(href);

                    if (cssInclude.type === 'link') {
                        // Less.js support (https://github.com/cloudhead/less.js)
                        if (/\bstylesheet\/less\b/i.test(cssInclude.node.getAttribute('rel')) && typeof less !== 'undefined') {
                            // Sadly this method isn't accessible
                            // less.loadStyleSheet(cssInclude.node, function () {}, false, 0);
                            // So instead we'll just have to brutally refresh ALL less includes
                            less.refresh();
                        } else {
                            replaceLinkTag(cssInclude.node, newHref);
                        }
                    }

                    if (cssInclude.type === 'import') {
                        replaceStyleTag(cssInclude.styleElement, cssInclude.href, newHref);
                    }

                    if (cssInclude.type === 'prefixfree') {
                        // The next two lines are hacks to make Prefixfree think this is a link and not a style block
                        cssInclude.node.setAttribute('href', href); // No cache buster needed
                        cssInclude.node.rel = 'stylesheet';
                        StyleFix.link(cssInclude.node);
                    }

                    // Replacing the first occurrence should be good enough. Besides, the @import replacement code invalidates
                    // the rest of the cssIncludes in the same stylesheet.
                    break;
                }
            }
        },
        startListening = function () {
            var socket = io.connect();

            socket.on('connect', function () {
                var hrefs = [],
                    watchNewStylesheets = function () {
                        var cssIncludes = findCssIncludes(),
                            toWatch = [],
                            url,
                            i;
                        cssIncludes.unshift({ href: location.pathname });

                        for (i = 0; i < cssIncludes.length; i += 1) {
                            url = removeCacheBuster(cssIncludes[i].href);
                            if (hrefs.indexOf(url) === -1) {
                                hrefs.push(url);
                                toWatch.push(url);
                            }
                        }

                        if (toWatch.length !== 0) {
                            log('Subscribing to ' + toWatch.length + ' files:\n  ' + toWatch.join('\n  '));
                            socket.emit('watch', toWatch);
                        }
                    };

                watchNewStylesheets();
                setInterval(watchNewStylesheets, pollTimeout);
            }).on('change', function (url) {
                log('Received change notification for ' + url + ', refreshing');
                refresh(url);
            });
        },
        state = {},
        startPolling = function () {
            var getXHR = function () {
                    try {
                        return new XMLHttpRequest();
                    } catch (e1) {
                        try {
                            return new ActiveXObject("Msxml2.XMLHTTP.6.0");
                        } catch (e2) {
                            try {
                                return new ActiveXObject("Msxml2.XMLHTTP.3.0");
                            } catch (e3) {
                                try {
                                    return new ActiveXObject("Msxml2.XMLHTTP");
                                } catch (e4) {
                                    try {
                                        return new ActiveXObject("Microsoft.XMLHTTP");
                                    } catch (e5) {}
                                }
                            }
                        }
                    }

                    return null; // no XHR support
                },
                cssIncludes = findCssIncludes(),
                proceed = function () {
                    var cssInclude,
                        url,
                        xhr;

                    if (cssIncludes.length > 0) {
                        cssInclude = cssIncludes.shift();
                        url = removeCacheBuster(cssInclude.href);
                        xhr = getXHR();

                        xhr.onreadystatechange = function () {
                            var lastModified,
                                etag;

                            if (xhr.readyState === 4) {
                                if (xhr.status === 200) {
                                    lastModified = Date.parse(xhr.getResponseHeader("Last-Modified"));
                                    etag = xhr.getResponseHeader("ETag");

                                    if (!state[url] || state[url].lastModified < lastModified || state[url].etag !== etag) {
                                        state[url] = {
                                            lastModified: lastModified,
                                            etag: etag
                                        };
                                        refresh(url);
                                    }
                                }

                                proceed();
                            }
                        };
                        xhr.open('HEAD', addCacheBuster(url), true);
                        xhr.send(null);
                    } else {
                        setTimeout(startPolling, pollTimeout);
                    }
                };
            cssIncludes.unshift({ href: location.pathname });
            proceed();
        };

    if (typeof io !== 'undefined') {
        log('socket.io present, connecting');
        startListening();
    } else {
        log('socket.io not present, falling back to polling mode');
        startPolling();
    }
}());
