# Copyright 2013, 2014 Kevin Reid <kpreid@switchb.org>
# 
# This file is part of ShinySDR.
# 
# ShinySDR is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
# 
# ShinySDR is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
# 
# You should have received a copy of the GNU General Public License
# along with ShinySDR.  If not, see <http://www.gnu.org/licenses/>.

# pylint: disable=no-member
# (pylint is confused by assertRaisesRegexp)

from __future__ import absolute_import, division

import textwrap

from twisted.trial import unittest

from gnuradio import blocks
from gnuradio import gr

from shinysdr.blocks import MultistageChannelFilter


class TestMultistageChannelFilter(unittest.TestCase):
    def test_setters(self):
        # TODO: Test filter functionality; this only tests that the operations work
        filt = MultistageChannelFilter(input_rate=32000000, output_rate=16000, cutoff_freq=3000, transition_width=1200)
        filt.set_cutoff_freq(2900)
        filt.set_transition_width(1000)
        filt.set_center_freq(10000)
        self.assertEqual(2900, filt.get_cutoff_freq())
        self.assertEqual(1000, filt.get_transition_width())
        self.assertEqual(10000, filt.get_center_freq())
    
    def test_too_wide_cutoff(self):
        self.assertRaisesRegexp(ValueError, '500.*182', MultistageChannelFilter, input_rate=200000, output_rate=182, cutoff_freq=500, transition_width=18.2)
    
    def test_basic(self):
        # TODO: Test filter functionality more
        f = MultistageChannelFilter(input_rate=32000000, output_rate=16000, cutoff_freq=3000, transition_width=1200)
        self.__run(f, 400000, 16000 / 32000000)
    
    def test_float_rates(self):
        # Either float or int rates should be accepted
        f = MultistageChannelFilter(input_rate=32000000.0, output_rate=16000.0, cutoff_freq=3000, transition_width=1200)
        self.__run(f, 400000, 16000 / 32000000)
    
    def test_interpolating(self):
        '''Output rate higher than input rate'''
        # TODO: Test filter functionality more
        f = MultistageChannelFilter(input_rate=8000, output_rate=20000, cutoff_freq=8000, transition_width=5000)
        self.__run(f, 4000, 20000 / 8000)
    
    def test_odd_interpolating(self):
        '''Output rate higher than input rate and not a multiple'''
        # TODO: Test filter functionality more
        f = MultistageChannelFilter(input_rate=8000, output_rate=21234, cutoff_freq=8000, transition_width=5000)
        self.__run(f, 4000, 21234 / 8000)
    
    def test_decimating(self):
        '''Sample problematic decimation case'''
        # TODO: Test filter functionality more
        f = MultistageChannelFilter(input_rate=8000000, output_rate=48000, cutoff_freq=10000, transition_width=5000)
        self.__run(f, 400000, 48000 / 8000000)
    
    def test_explain(self):
        f = MultistageChannelFilter(input_rate=10000, output_rate=1000, cutoff_freq=500, transition_width=100)
        self.assertEqual(f.explain(), textwrap.dedent('''\
            2 stages from 10000 to 1000
              decimate by 5 using  43 taps (86000) in freq_xlating_fir_filter_ccc_sptr
              decimate by 2 using  49 taps (49000) in fft_filter_ccc_sptr
            No final resampler stage.'''))
    
    def __run(self, block, in_size, ratio):
        '''check that the actual relative rate is as expected'''
        delta_1 = self.__run1(block, in_size, ratio)
        delta_2 = self.__run1(block, in_size * 2, ratio)
        delta_3 = self.__run1(block, in_size * 10, ratio)
        self.assertApproximates(0, delta_3, 100, '%f fewer output samples than expected' % delta_3)
        msg = 'varying delta: %i %i %i' % (delta_1, delta_2, delta_3)
        self.assertApproximates(delta_1, delta_2, 200, msg)
        self.assertApproximates(delta_2, delta_3, 200, msg)
    
    def __run1(self, block, in_size, ratio):
        top = gr.top_block()
        sink = blocks.vector_sink_c()
        top.connect(
            blocks.vector_source_c([0] * in_size),
            block,
            sink)
        top.start()
        top.wait()
        top.stop()
        reference_out_size = in_size * ratio
        return reference_out_size - len(sink.data())
